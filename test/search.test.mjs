import { test } from "node:test";
import assert from "node:assert/strict";

import { searchChunks, formatEvidencePacket } from "../build/search.js";
import { buildSearchIndex } from "../build/repo-index.js";

const chunks = [
  { path: "src/search.ts", startLine: 1, endLine: 40, text: "bm25 scoring ranker tokenize query terms idf" },
  { path: "src/index.ts", startLine: 1, endLine: 40, text: "register mcp tools server connect stdio transport" },
  { path: "README.md", startLine: 1, endLine: 40, text: "a tiny mcp server that indexes a repository" },
];
const index = buildSearchIndex(chunks);

test("ranks the most relevant chunk first", () => {
  const hits = searchChunks(index, "bm25 scoring ranker", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].path, "src/search.ts");
  assert.ok(hits[0].score > 0);
});

test("respects topK", () => {
  const hits = searchChunks(index, "mcp server", 1);
  assert.equal(hits.length, 1);
});

test("returns nothing for an empty query or empty corpus", () => {
  assert.deepEqual(searchChunks(index, "   ", 5), []);
  assert.deepEqual(searchChunks(buildSearchIndex([]), "mcp", 5), []);
});

test("only returns positively-scoring chunks", () => {
  const hits = searchChunks(index, "zzqqxj nonexistentgibberishtoken", 5);
  assert.deepEqual(hits, []);
});

test("prototype-named tokens don't corrupt scoring", () => {
  // "constructor"/"__proto__" are Object.prototype keys; the ranker must treat
  // them as ordinary terms, not inherited properties.
  const proto = buildSearchIndex([
    { path: "a.ts", startLine: 1, endLine: 5, text: "class Foo constructor toString valueof" },
    { path: "b.ts", startLine: 1, endLine: 5, text: "unrelated helper utility" },
  ]);
  const hits = searchChunks(proto, "constructor", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "a.ts");
  assert.ok(Number.isFinite(hits[0].score) && hits[0].score > 0);
});

test("truncates snippets longer than 4000 chars", () => {
  const big = buildSearchIndex([
    { path: "big.ts", startLine: 1, endLine: 500, text: "alpha " + "x".repeat(5000) },
  ]);
  const hits = searchChunks(big, "alpha", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].truncated, true);
  assert.equal(hits[0].snippet.length, 4000);
});

test("formatEvidencePacket reports a no-match message", () => {
  assert.equal(formatEvidencePacket([]), "No matching chunks found.");
});

test("formatEvidencePacket includes FILE/LINES/SCORE headers", () => {
  const hits = searchChunks(index, "bm25", 1);
  const out = formatEvidencePacket(hits);
  assert.match(out, /FILE: src\/search\.ts/);
  assert.match(out, /LINES: 1-40/);
  assert.match(out, /SCORE:/);
});
