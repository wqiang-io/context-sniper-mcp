import { promises as fs } from "node:fs";
import path from "node:path";

import { tokenize } from "./tokenize.js";

export interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** A chunk plus its precomputed BM25 statistics (persisted in the index). */
export interface IndexedChunk extends Chunk {
  /** Term -> occurrences within this chunk (over text + path). */
  termFreq: Record<string, number>;
  /** Total token count of the chunk (BM25 document length). */
  length: number;
}

/** In-memory search index: chunks plus corpus-wide stats. */
export interface SearchIndex {
  chunks: IndexedChunk[];
  /** Term -> number of chunks that contain it (document frequency). */
  df: Record<string, number>;
  /** Average chunk token length across the corpus. */
  avgLength: number;
  chunkCount: number;
}

/** Bump when the on-disk shape changes; older indexes are treated as missing. */
const INDEX_VERSION = 2;

interface IndexFile {
  version: number;
  root: string;
  generatedAt: string;
  fileCount: number;
  chunkCount: number;
  avgLength: number;
  df: Record<string, number>;
  chunks: IndexedChunk[];
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "target",
  ".context-index",
]);

const ALLOWED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".md",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
]);

// Files whose extension passes the allowlist but whose content is generated
// noise: dependency lockfiles and minified/bundled output. Matched by basename.
const IGNORE_FILE_RE = /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml)$|\.min\.[jt]sx?$|\.bundle\.js$/i;

// Skip individual files above this size — typically generated data blobs or
// single-line minified files that would bloat the index without being useful
// search targets. Hand-written source is virtually always well under this.
const MAX_FILE_BYTES = 512 * 1024;

const WINDOW_STEP = 80;
const WINDOW_MAX = 120;
const INDEX_DIR_NAME = ".context-index";
const INDEX_FILE_NAME = "chunks.json";

export class PathEscapeError extends Error {
  constructor(offender: string) {
    super(`Path escapes repo root: ${offender}`);
    this.name = "PathEscapeError";
  }
}

/**
 * Resolves `target` relative to `root` and guarantees the result stays
 * inside `root`. Throws PathEscapeError otherwise.
 */
export function resolveSafePath(root: string, target: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(resolvedRoot, target);

  const relative = path.relative(resolvedRoot, resolvedTarget);
  const escapes =
    relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);

  if (escapes) {
    throw new PathEscapeError(target);
  }

  return resolvedTarget;
}

export function getIndexPath(root: string): string {
  const resolvedRoot = path.resolve(root);
  return path.join(resolvedRoot, INDEX_DIR_NAME, INDEX_FILE_NAME);
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      await walk(fullPath, root, out);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) continue;
    if (IGNORE_FILE_RE.test(entry.name)) continue;

    out.push(fullPath);
  }
}

export async function scanRepo(root: string): Promise<string[]> {
  const resolvedRoot = path.resolve(root);
  const files: string[] = [];
  await walk(resolvedRoot, resolvedRoot, files);
  return files;
}

export function chunkText(text: string): Array<{ startLine: number; endLine: number; text: string }> {
  const lines = text.split("\n");
  const totalLines = lines.length;
  const chunks: Array<{ startLine: number; endLine: number; text: string }> = [];

  if (totalLines === 0) return chunks;

  for (let start = 0; start < totalLines; start += WINDOW_STEP) {
    const end = Math.min(start + WINDOW_MAX, totalLines);
    const slice = lines.slice(start, end).join("\n");
    chunks.push({
      startLine: start + 1,
      endLine: end,
      text: slice,
    });
    if (end >= totalLines) break;
  }

  return chunks;
}

/**
 * Term frequencies + token length for a single chunk. Uses a null-prototype
 * object so token keys like "constructor" or "__proto__" become plain own
 * properties instead of colliding with Object.prototype.
 */
function computeTermFreq(text: string): { termFreq: Record<string, number>; length: number } {
  const tokens = tokenize(text);
  const termFreq: Record<string, number> = Object.create(null);
  for (const t of tokens) {
    termFreq[t] = (termFreq[t] ?? 0) + 1;
  }
  return { termFreq, length: tokens.length };
}

/**
 * Build the full search index (per-chunk term frequencies + corpus-wide
 * document frequencies and average length) from plain chunks. Shared by
 * indexRepo (for persistence) and available directly for tests.
 */
export function buildSearchIndex(baseChunks: Chunk[]): SearchIndex {
  const chunks: IndexedChunk[] = [];
  const df: Record<string, number> = Object.create(null);
  let totalLength = 0;

  for (const c of baseChunks) {
    // Match the original ranker: score over the chunk text plus its path.
    const { termFreq, length } = computeTermFreq(`${c.text} ${c.path}`);
    chunks.push({ ...c, termFreq, length });
    totalLength += length;
    for (const term in termFreq) {
      df[term] = (df[term] ?? 0) + 1;
    }
  }

  const avgLength = chunks.length > 0 ? totalLength / chunks.length : 0;
  return { chunks, df, avgLength, chunkCount: chunks.length };
}

export interface IndexResult {
  root: string;
  fileCount: number;
  chunkCount: number;
  indexPath: string;
}

export async function indexRepo(root: string): Promise<IndexResult> {
  const resolvedRoot = path.resolve(root);
  const stat = await fs.stat(resolvedRoot).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`root does not exist or is not a directory: ${resolvedRoot}`);
  }

  const files = await scanRepo(resolvedRoot);
  const chunks: Chunk[] = [];
  let indexedFileCount = 0;

  for (const filePath of files) {
    // Skip oversized files (generated blobs, single-line minified output)
    // before reading them into memory.
    const fileStat = await fs.stat(filePath).catch(() => null);
    if (!fileStat || fileStat.size > MAX_FILE_BYTES) continue;

    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }

    // Skip binary-ish files that slipped through the extension filter.
    if (content.includes("\0")) continue;

    const relPath = path.relative(resolvedRoot, filePath).split(path.sep).join("/");
    const fileChunks = chunkText(content);
    for (const c of fileChunks) {
      chunks.push({
        path: relPath,
        startLine: c.startLine,
        endLine: c.endLine,
        text: c.text,
      });
    }
    indexedFileCount += 1;
  }

  const indexPath = getIndexPath(resolvedRoot);
  const indexDir = path.dirname(indexPath);
  await fs.mkdir(indexDir, { recursive: true });

  const searchIndex = buildSearchIndex(chunks);

  const payload: IndexFile = {
    version: INDEX_VERSION,
    root: resolvedRoot,
    generatedAt: new Date().toISOString(),
    fileCount: indexedFileCount,
    chunkCount: searchIndex.chunkCount,
    avgLength: searchIndex.avgLength,
    df: searchIndex.df,
    chunks: searchIndex.chunks,
  };

  // Write to a temp file in the same directory, then rename into place.
  // rename() is atomic on a single filesystem, so a concurrent search_code
  // never observes a half-written (unparseable) index.
  const tmpPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload), "utf8");
  try {
    await fs.rename(tmpPath, indexPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return {
    root: resolvedRoot,
    fileCount: indexedFileCount,
    chunkCount: chunks.length,
    indexPath,
  };
}

// Process-lifetime cache so repeated search_code calls don't re-read and
// re-parse the index. Keyed by resolved index path, invalidated by mtime.
const indexCache = new Map<string, { mtimeMs: number; index: SearchIndex }>();

/**
 * Load the search index for `root`, returning null if none exists or it's from
 * an older/unreadable format (callers then prompt for a re-index). Parsed
 * indexes are cached and reused until the file's mtime changes.
 */
export async function loadIndex(root: string): Promise<SearchIndex | null> {
  const indexPath = getIndexPath(root);

  let stat;
  try {
    stat = await fs.stat(indexPath);
  } catch {
    return null;
  }

  const cached = indexCache.get(indexPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.index;
  }

  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return null;
  }

  let parsed: IndexFile;
  try {
    parsed = JSON.parse(raw) as IndexFile;
  } catch {
    return null;
  }

  if (
    parsed.version !== INDEX_VERSION
    || !Array.isArray(parsed.chunks)
    || typeof parsed.df !== "object"
    || parsed.df === null
  ) {
    return null;
  }

  const index: SearchIndex = {
    chunks: parsed.chunks,
    df: parsed.df,
    avgLength: typeof parsed.avgLength === "number" && parsed.avgLength > 0 ? parsed.avgLength : 1,
    chunkCount: parsed.chunks.length,
  };

  indexCache.set(indexPath, { mtimeMs: stat.mtimeMs, index });
  return index;
}
