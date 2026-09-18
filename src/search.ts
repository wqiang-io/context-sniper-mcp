import type { IndexedChunk, SearchIndex } from "./repo-index.js";
import { tokenize } from "./tokenize.js";

const MAX_SNIPPET_CHARS = 4000;

/**
 * Default total character budget for one evidence packet. Defined once here
 * and imported by both entry points (MCP tool schema and CLI flag).
 */
export const DEFAULT_MAX_CHARS = 6000;

/** Lines kept on each side of a line that contains a query token. */
const CONTEXT_LINES = 2;

/**
 * Kept ranges separated by at most this many unmatched lines are joined: an
 * omission marker would cost more than the lines it hides.
 */
const MERGE_GAP_LINES = 2;

const HIT_SEPARATOR = "\n\n";

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  truncated: boolean;
  /**
   * When `truncated`, the first line that is not fully shown (the cap can
   * land mid-line): read_snippet from here to endLine recovers the rest.
   */
  truncatedFromLine?: number;
  /**
   * True when the chunk matched only through its path tokens. The snippet is
   * then a one-line pointer to the file region instead of code.
   */
  pathOnly: boolean;
}

/** Inclusive, 1-based, absolute line range within a file. */
interface LineRange {
  start: number;
  end: number;
}

interface Candidate {
  chunk: IndexedChunk;
  score: number;
  /** Trimmed ranges (absolute lines); empty when the chunk matched on path only. */
  ranges: LineRange[];
}

/** Safe lookup on a possibly JSON-parsed (Object.prototype-bearing) map. */
function freq(map: Record<string, number>, term: string): number {
  return Object.hasOwn(map, term) ? map[term] : 0;
}

/** Sort ranges and join any two separated by at most MERGE_GAP_LINES lines. */
function mergeRanges(ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + 1 + MERGE_GAP_LINES) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}

/**
 * The lines of `chunk` worth returning: every line containing a query term,
 * plus CONTEXT_LINES on each side, with nearby ranges joined. Empty when no
 * line contains a query term, i.e. the chunk matched only through its path.
 */
function trimChunk(chunk: IndexedChunk, queryTerms: Set<string>): LineRange[] {
  const lines = chunk.text.split("\n");
  const ranges: LineRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!tokenize(lines[i]).some((tok) => queryTerms.has(tok))) continue;
    ranges.push({
      start: chunk.startLine + Math.max(0, i - CONTEXT_LINES),
      end: chunk.startLine + Math.min(lines.length - 1, i + CONTEXT_LINES),
    });
  }
  return mergeRanges(ranges);
}

/** One hit for several same-file candidates whose trimmed spans overlap or touch. */
function mergedHit(path: string, members: Candidate[]): SearchHit {
  // Absolute line -> text. Overlapping windows carry identical text, so any
  // member that covers a line can supply it.
  const lineText = new Map<number, string>();
  for (const { chunk } of members) {
    const lines = chunk.text.split("\n");
    for (let i = 0; i < lines.length; i++) lineText.set(chunk.startLine + i, lines[i]);
  }

  const ranges = mergeRanges(members.flatMap((m) => m.ranges));
  const pieces: string[] = [];
  // Absolute line of each piece; a gap marker carries the next segment's start.
  const pieceLines: number[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const { start, end } = ranges[i];
    if (i > 0) {
      pieces.push(`... (lines ${ranges[i - 1].end + 1}-${start - 1} omitted)`);
      pieceLines.push(start);
    }
    for (let line = start; line <= end; line++) {
      pieces.push(lineText.get(line) ?? "");
      pieceLines.push(line);
    }
  }
  const body = pieces.join("\n");
  const truncated = body.length > MAX_SNIPPET_CHARS;

  // The first piece that does not fit entirely under the cap is where a
  // caller has to resume reading.
  let truncatedFromLine: number | undefined;
  if (truncated) {
    let offset = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (offset + pieces[i].length > MAX_SNIPPET_CHARS) {
        truncatedFromLine = pieceLines[i];
        break;
      }
      offset += pieces[i].length + 1;
    }
  }

  return {
    path,
    startLine: ranges[0].start,
    endLine: ranges[ranges.length - 1].end,
    score: Math.max(...members.map((m) => m.score)),
    snippet: truncated ? body.slice(0, MAX_SNIPPET_CHARS) : body,
    truncated,
    ...(truncatedFromLine !== undefined ? { truncatedFromLine } : {}),
    pathOnly: false,
  };
}

/** A pointer hit for a file that matched only through its path tokens. */
function pathOnlyHit(path: string, members: Candidate[]): SearchHit {
  const startLine = Math.min(...members.map((m) => m.chunk.startLine));
  const endLine = Math.max(...members.map((m) => m.chunk.endLine));
  return {
    path,
    startLine,
    endLine,
    score: Math.max(...members.map((m) => m.score)),
    snippet:
      `(matched on path only: no query token in lines ${startLine}-${endLine}; ` +
      `use read_snippet ${path} ${startLine} ${endLine} to view)`,
    truncated: false,
    pathOnly: true,
  };
}

/**
 * Turn the top-K candidates into hits. Same-file candidates whose trimmed
 * spans overlap or touch become one hit, so the 40-line window overlap is
 * never returned twice. Path-only candidates become a single pointer per file,
 * and only when that file has no text-matching hit in the packet.
 */
function buildHits(candidates: Candidate[]): SearchHit[] {
  const byPath = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byPath.get(c.chunk.path);
    if (list) list.push(c);
    else byPath.set(c.chunk.path, [c]);
  }

  const hits: SearchHit[] = [];
  for (const [path, list] of byPath) {
    const textMatched = list.filter((c) => c.ranges.length > 0);
    if (textMatched.length === 0) {
      hits.push(pathOnlyHit(path, list));
      continue;
    }

    textMatched.sort((a, b) => a.ranges[0].start - b.ranges[0].start);
    let group: Candidate[] = [];
    let groupEnd = 0;
    for (const c of textMatched) {
      const start = c.ranges[0].start;
      const end = c.ranges[c.ranges.length - 1].end;
      if (group.length > 0 && start > groupEnd + 1 + MERGE_GAP_LINES) {
        hits.push(mergedHit(path, group));
        group = [];
      }
      group.push(c);
      groupEnd = group.length === 1 ? end : Math.max(groupEnd, end);
    }
    hits.push(mergedHit(path, group));
  }
  return hits;
}

/**
 * BM25 scoring over a prebuilt index. Term frequencies, document frequencies,
 * and average length are computed once at index time (see buildSearchIndex),
 * so each query only computes per-term idf and scans chunks to score them.
 *
 * `topK` bounds the candidate chunks considered. Each candidate is trimmed to
 * the lines containing query terms (plus context) and same-file candidates
 * with overlapping ranges are merged, so fewer than topK hits may come back.
 */
export function searchChunks(index: SearchIndex, query: string, topK = 5): SearchHit[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0 || index.chunkCount === 0) return [];

  const N = index.chunkCount;
  const avgLen = index.avgLength || 1;
  const k1 = 1.5;
  const b = 0.75;

  // Precompute idf for the query terms that actually occur in the corpus.
  const idf = new Map<string, number>();
  for (const term of queryTokens) {
    const df = freq(index.df, term);
    if (df === 0) continue;
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }
  if (idf.size === 0) return [];

  const scored: Array<{ chunk: IndexedChunk; score: number }> = [];
  for (const chunk of index.chunks) {
    let score = 0;
    for (const [term, termIdf] of idf) {
      const tf = freq(chunk.termFreq, term);
      if (tf === 0) continue;
      const denom = tf + k1 * (1 - b + (b * chunk.length) / avgLen);
      score += termIdf * ((tf * (k1 + 1)) / denom);
    }
    if (score > 0) scored.push({ chunk, score });
  }

  scored.sort((a, b2) => b2.score - a.score);

  // Output layer: trim each candidate to the lines that carry query terms,
  // merge same-file candidates whose trimmed spans overlap, and order by score.
  const queryTerms = new Set(idf.keys());
  const candidates: Candidate[] = scored.slice(0, topK).map(({ chunk, score }) => ({
    chunk,
    score: Math.round(score * 1000) / 1000,
    ranges: trimChunk(chunk, queryTerms),
  }));
  const hits = buildHits(candidates);
  hits.sort((a, b2) => b2.score - a.score || a.path.localeCompare(b2.path) || a.startLine - b2.startLine);
  return hits;
}

function hitHeader(hit: SearchHit, n: number): string {
  return `[${n}] FILE: ${hit.path}\nLINES: ${hit.startLine}-${hit.endLine}\nSCORE: ${hit.score}`;
}

function renderHit(hit: SearchHit, n: number): string {
  let cap = "";
  if (hit.truncated) {
    const resume =
      hit.truncatedFromLine !== undefined
        ? `; use read_snippet ${hit.path} ${hit.truncatedFromLine} ${hit.endLine} to expand`
        : "";
    cap = `\n... (truncated at ${MAX_SNIPPET_CHARS} chars${resume})`;
  }
  const body = "```\n" + hit.snippet + cap + "\n```";
  return `${hitHeader(hit, n)}\n${body}`;
}

/**
 * Render as many whole snippet lines of `hit` as fit in `avail` chars, then a
 * marker saying how much was withheld and how to fetch it. Returns null when
 * not even the header and marker fit.
 */
function renderPartialHit(hit: SearchHit, n: number, avail: number): string | null {
  const head = `${hitHeader(hit, n)}\n\`\`\`\n`;
  const tail = "\n```";
  const marker = (omitted: number) =>
    `... (budget: ${omitted} chars omitted; use read_snippet ${hit.path} ${hit.startLine} ${hit.endLine} to expand)`;

  // Reserve room for the marker carrying the largest count it could show.
  const room = avail - head.length - marker(hit.snippet.length).length - tail.length;
  if (room < 0) return null;

  const kept: string[] = [];
  let keptChars = 0; // kept text plus the newline separating it from the marker
  for (const line of hit.snippet.split("\n")) {
    if (keptChars + line.length + 1 > room) break;
    kept.push(line);
    keptChars += line.length + 1;
  }
  const shown = kept.length > 0 ? keptChars - 1 : 0;
  kept.push(marker(hit.snippet.length - shown));
  return head + kept.join("\n") + tail;
}

/**
 * Trailer listing hits that did not fit, in the longest form that fits in
 * `avail` chars: the list is shortened first, and only as a last resort does
 * it degrade to a bare count (`listed` is then 0).
 */
function budgetTrailer(omitted: SearchHit[], avail: number, more: boolean): { text: string; listed: number } {
  const count = `${omitted.length}${more ? " more" : ""} hit${omitted.length === 1 ? "" : "s"} omitted`;
  const entries = omitted.map((h) => `${h.path} ${h.startLine}-${h.endLine}`);
  for (let listed = entries.length; listed > 0; listed--) {
    const list =
      entries.slice(0, listed).join(", ") + (listed < entries.length ? `, +${entries.length - listed} more` : "");
    const text = `... (budget: ${count}: ${list}; use read_snippet <path> <start> <end> to expand, or raise maxChars)`;
    if (text.length <= avail) return { text, listed };
  }
  return { text: `... (budget: ${count}; raise maxChars to see them)`, listed: 0 };
}

/**
 * Render hits as an evidence packet of at most `maxChars` characters. Whole
 * hits are added in score order while they fit; the first hit that does not
 * fit is cut at a line boundary with a budget marker, and any hits after it
 * are listed (FILE + LINES) so the caller can fetch them with read_snippet.
 * Whenever at least one hit is shown, the trailer names at least one omitted
 * hit; whole hits are given back from the end of the packet to make room for
 * that. Only a budget too small to show anything gets a bare count.
 */
export function formatEvidencePacket(hits: SearchHit[], maxChars = DEFAULT_MAX_CHARS): string {
  if (hits.length === 0) {
    return "No matching chunks found.";
  }

  const parts: string[] = [];
  let used = 0;
  let next = 0;
  while (next < hits.length) {
    const block = renderHit(hits[next], next + 1);
    const cost = (parts.length > 0 ? HIT_SEPARATOR.length : 0) + block.length;
    if (used + cost > maxChars) break;
    parts.push(block);
    used += cost;
    next += 1;
  }
  if (next === hits.length) return parts.join(HIT_SEPARATOR);

  // Budget exhausted at hits[next]. Show what fits of it plus a trailer that
  // names the rest; if a trailer with at least one path does not fit, give
  // back whole hits from the end until it does.
  for (;;) {
    const avail = maxChars - used - (parts.length > 0 ? HIT_SEPARATOR.length : 0);
    const rest = hits.slice(next + 1);

    if (rest.length > 0) {
      const trailer = budgetTrailer(rest, avail, true);
      if (trailer.listed > 0) {
        const partial = renderPartialHit(hits[next], next + 1, avail - trailer.text.length - HIT_SEPARATOR.length);
        if (partial !== null) return [...parts, partial, trailer.text].join(HIT_SEPARATOR);
      }
    } else {
      const partial = renderPartialHit(hits[next], next + 1, avail);
      if (partial !== null) return [...parts, partial].join(HIT_SEPARATOR);
    }

    const trailer = budgetTrailer(hits.slice(next), avail, parts.length > 0);
    if (trailer.listed > 0 && trailer.text.length <= avail) return [...parts, trailer.text].join(HIT_SEPARATOR);
    if (parts.length === 0) return trailer.text; // nothing fits: bare count, may exceed a tiny budget

    next -= 1;
    const popped = parts.pop() as string;
    used -= popped.length + (parts.length > 0 ? HIT_SEPARATOR.length : 0);
  }
}
