import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveSafePath,
  PathEscapeError,
  chunkText,
  buildSearchIndex,
  indexRepo,
  loadIndex,
  getIndexPath,
  formatIndexResult,
} from "../build/repo-index.js";

test("resolveSafePath allows paths inside root and rejects escapes", () => {
  const root = "/tmp/repo";
  assert.equal(resolveSafePath(root, "src/a.ts"), path.resolve("/tmp/repo/src/a.ts"));
  assert.equal(resolveSafePath(root, "/tmp/repo/src/a.ts"), path.resolve("/tmp/repo/src/a.ts"));
  assert.throws(() => resolveSafePath(root, "../secret"), PathEscapeError);
  assert.throws(() => resolveSafePath(root, "../../etc/passwd"), PathEscapeError);
  assert.throws(() => resolveSafePath(root, "/etc/passwd"), PathEscapeError);
});

test("chunkText produces overlapping windows with 1-based line ranges", () => {
  const text = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join("\n");
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 120); // WINDOW_MAX
  assert.equal(chunks[1].startLine, 81); // WINDOW_STEP + 1 -> overlap
  // Last chunk must cover the final line.
  assert.equal(chunks[chunks.length - 1].endLine, 200);
});

test("chunkText keeps a short file in a single chunk", () => {
  const chunks = chunkText("a\nb\nc");
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    { s: chunks[0].startLine, e: chunks[0].endLine },
    { s: 1, e: 3 },
  );
});

test("buildSearchIndex precomputes term/document frequencies and avg length", () => {
  const index = buildSearchIndex([
    { path: "a.ts", startLine: 1, endLine: 2, text: "alpha alpha beta" },
    { path: "b.ts", startLine: 1, endLine: 2, text: "beta gamma" },
  ]);
  assert.equal(index.chunkCount, 2);
  assert.equal(index.chunks[0].termFreq.alpha, 2);
  assert.equal(index.chunks[0].termFreq.beta, 1);
  // "beta" appears in both chunks -> df 2; "alpha" only in the first -> df 1.
  assert.equal(index.df.beta, 2);
  assert.equal(index.df.alpha, 1);
  // Token length includes the path token, so it's > raw word count.
  assert.ok(index.avgLength > 0);
});

test("indexRepo writes a parseable index and loadIndex reads it back", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-idx-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const x = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "# hello\n", "utf8");
  // Ignored: binary content (NUL byte) and a default-ignored directory.
  await fs.writeFile(path.join(root, "notes.bin"), "\0\0\0", "utf8");
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "dep.js"), "module.exports={}\n", "utf8");

  const result = await indexRepo(root);
  assert.equal(result.fileCount, 2, "only a.ts and README.md are indexed");
  assert.ok(result.chunkCount >= 2);

  // Index file must be valid JSON on disk (atomic-write sanity) and carry stats.
  const raw = await fs.readFile(getIndexPath(root), "utf8");
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.version, 2);
  assert.equal(typeof onDisk.df, "object");
  assert.equal(typeof onDisk.avgLength, "number");

  const index = await loadIndex(root);
  assert.ok(index);
  assert.ok(index.chunks.some((c) => c.path === "src/a.ts"));
  assert.ok(index.chunks.every((c) => !c.path.startsWith("node_modules")));
  assert.ok(index.chunks.every((c) => typeof c.length === "number" && c.termFreq));
});

test("indexRepo skips lockfiles, minified bundles, and oversized files (#6)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-skip-"));
  await fs.writeFile(path.join(root, "a.ts"), "export const kept = 1;\n", "utf8");
  // Generated noise covered by the built-in ignore rules.
  await fs.writeFile(path.join(root, "package-lock.json"), JSON.stringify({ a: 1 }), "utf8");
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf8");
  await fs.writeFile(path.join(root, "app.min.js"), "var a=1;var b=2;\n", "utf8");
  // Oversized file (> 512 KB) even though it's a normal extension.
  await fs.writeFile(path.join(root, "big.json"), `{"blob":"${"x".repeat(600 * 1024)}"}`, "utf8");

  const result = await indexRepo(root);
  assert.equal(result.fileCount, 1, "only a.ts is indexed");

  const index = await loadIndex(root);
  const paths = new Set(index.chunks.map((c) => c.path));
  assert.deepEqual([...paths], ["a.ts"]);
});

test("loadIndex caches by mtime and refreshes after re-index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-cache-"));
  await fs.writeFile(path.join(root, "a.ts"), "export const first = 1;\n", "utf8");
  await indexRepo(root);

  const a = await loadIndex(root);
  const b = await loadIndex(root);
  assert.equal(a, b, "same mtime returns the cached instance");

  // Re-index with different content -> new mtime -> fresh (non-cached) index.
  await fs.writeFile(path.join(root, "b.ts"), "export const second = 2;\n", "utf8");
  await indexRepo(root);
  // Guarantee a distinct mtime so the assertion doesn't depend on clock resolution.
  const future = new Date(Date.now() + 10_000);
  await fs.utimes(getIndexPath(root), future, future);
  const c = await loadIndex(root);
  assert.notEqual(c, a, "re-index invalidates the cache");
  assert.ok(c.chunks.some((ch) => ch.path === "b.ts"));
});

test("loadIndex returns null when no index exists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-none-"));
  assert.equal(await loadIndex(root), null);
});

test("loadIndex returns null for a stale (wrong-version) index", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-old-"));
  const indexPath = getIndexPath(root);
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify({ version: 1, chunks: [] }), "utf8");
  assert.equal(await loadIndex(root), null);
});

test("indexRepo indexes any text file (scss, html, no extension) but not binaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-text-"));
  await fs.mkdir(path.join(root, "styles"));
  await fs.writeFile(path.join(root, "styles", "app.scss"), ".a { color: red; }\n", "utf8");
  await fs.writeFile(path.join(root, "index.html"), "<html><body>hi</body></html>\n", "utf8");
  await fs.writeFile(path.join(root, "Makefile"), "all:\n\techo hi\n", "utf8");
  await fs.writeFile(path.join(root, "logo.bin"), Buffer.from([0x89, 0x50, 0x00, 0x47]));

  const result = await indexRepo(root);
  assert.equal(result.fileCount, 3);
  assert.equal(result.csignoreRules, null);
  const paths = new Set((await loadIndex(root)).chunks.map((c) => c.path));
  assert.deepEqual([...paths].sort(), ["Makefile", "index.html", "styles/app.scss"]);
  assert.doesNotMatch(formatIndexResult(result), /csignore/);
});

test("indexRepo keeps secrets and lockfiles out by default but keeps .env.example", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-secret-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".env"), "API_KEY=sk-secret123\n", "utf8");
  await fs.writeFile(path.join(root, ".env.example"), "API_KEY=\n", "utf8");
  await fs.writeFile(path.join(root, "uv.lock"), "version = 1\n", "utf8");
  await fs.writeFile(path.join(root, "src", "a.py"), "x = 1\n", "utf8");

  const result = await indexRepo(root);
  assert.equal(result.fileCount, 2);
  const index = await loadIndex(root);
  assert.deepEqual([...new Set(index.chunks.map((c) => c.path))].sort(), [".env.example", "src/a.py"]);
  assert.ok(index.chunks.every((c) => !c.text.includes("secret123")));
});

test("indexRepo honours .csignore and reports what it skipped", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-csi-"));
  await fs.mkdir(path.join(root, "docs"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, ".csignore"), "# project rules\ndocs/\n*.generated.ts\n", "utf8");
  await fs.writeFile(path.join(root, "docs", "guide.md"), "# guide\n", "utf8");
  await fs.writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "b.generated.ts"), "export const b = 2;\n", "utf8");
  await fs.writeFile(path.join(root, "src", "c.ts"), "export const c = 3;\n", "utf8");

  const result = await indexRepo(root);
  assert.equal(result.fileCount, 2);
  assert.equal(result.csignoreRules, 2);
  assert.equal(result.csignoreSkipped, 2, "the docs directory and b.generated.ts");
  assert.match(formatIndexResult(result), /\.csignore: 2 rules, 2 files\/dirs skipped/);
  const paths = new Set((await loadIndex(root)).chunks.map((c) => c.path));
  assert.deepEqual([...paths].sort(), ["src/a.ts", "src/c.ts"]);
});
