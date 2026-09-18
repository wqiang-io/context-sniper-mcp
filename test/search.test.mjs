import { test } from "node:test";
import assert from "node:assert/strict";

import { searchChunks, formatEvidencePacket, DEFAULT_MAX_CHARS } from "../build/search.js";
import { buildSearchIndex, chunkText } from "../build/repo-index.js";
import { tokenize } from "../build/tokenize.js";

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
  // The cut landed inside the only line, so reading resumes at that line.
  assert.equal(hits[0].truncatedFromLine, 1);
  assert.match(formatEvidencePacket(hits), /\n\.\.\. \(truncated at 4000 chars; use read_snippet big\.ts 1 1 to expand\)\n```$/);
});

test("formatEvidencePacket reports a no-match message", () => {
  assert.equal(formatEvidencePacket([]), "No matching chunks found.");
});

test("formatEvidencePacket includes FILE/LINES/SCORE headers", () => {
  const hits = searchChunks(index, "bm25", 1);
  const out = formatEvidencePacket(hits);
  assert.match(out, /FILE: src\/search\.ts/);
  // The fixture declares 40 lines but holds a single line of text; LINES
  // reports the trimmed range actually returned, not the chunk window.
  assert.match(out, /^LINES: 1-1$/m);
  assert.match(out, /SCORE:/);
});

// --- Output layer: trimming, merging, budget ---------------------------------

/** Chunks for one file using the real 80/120-line windowing from repo-index. */
function fileChunks(path, lines) {
  return chunkText(lines.join("\n")).map((c) => ({ path, ...c }));
}

/** `count` filler lines, with the 1-based lines in `marks` replaced. */
function filler(count, marks = {}) {
  return Array.from({ length: count }, (_, i) => marks[i + 1] ?? `l${i + 1} filler text`);
}

/** Chunks in distinct files whose every line matches "alpha". */
function wideChunks(count, linesPerChunk = 30) {
  return Array.from({ length: count }, (_, i) => ({
    path: `src/f${i}.ts`,
    startLine: 1,
    endLine: linesPerChunk,
    text: Array.from({ length: linesPerChunk }, (_, j) => `alpha line ${j + 1} ${"x".repeat(40)}`).join("\n"),
  }));
}

/** [n] FILE / LINES headers of a packet. */
function headers(packet) {
  return [...packet.matchAll(/^\[(\d+)\] FILE: (.+)\nLINES: (\d+)-(\d+)$/gm)].map((m) => ({
    n: Number(m[1]),
    path: m[2],
    start: Number(m[3]),
    end: Number(m[4]),
  }));
}

test("trims a hit to matching lines plus 2 lines of context and marks the gap", () => {
  const index = buildSearchIndex(fileChunks("a.ts", filler(60, { 5: "the needle is here", 13: "another needle" })));
  const hits = searchChunks(index, "needle", 5);
  assert.equal(hits.length, 1);
  assert.equal(`${hits[0].startLine}-${hits[0].endLine}`, "3-15");
  assert.equal(hits[0].pathOnly, false);
  assert.deepEqual(hits[0].snippet.split("\n"), [
    "l3 filler text",
    "l4 filler text",
    "the needle is here",
    "l6 filler text",
    "l7 filler text",
    "... (lines 8-10 omitted)",
    "l11 filler text",
    "l12 filler text",
    "another needle",
    "l14 filler text",
    "l15 filler text",
  ]);
});

test("joins kept ranges separated by at most 2 unmatched lines", () => {
  const index = buildSearchIndex(fileChunks("a.ts", filler(60, { 5: "needle", 12: "needle" })));
  const hits = searchChunks(index, "needle", 5);
  assert.equal(hits.length, 1);
  assert.equal(`${hits[0].startLine}-${hits[0].endLine}`, "3-14");
  assert.doesNotMatch(hits[0].snippet, /omitted/);
  assert.equal(hits[0].snippet.split("\n").length, 12);
});

test("merges overlapping windows of one file into a single range", () => {
  // Lines 95 and 100 sit in the 40-line overlap of windows 1-120 and 81-200,
  // so both chunks score; the packet must return that region exactly once.
  const chunks = fileChunks("src/a.ts", filler(200, { 95: "needle one", 100: "needle two" }));
  assert.deepEqual(chunks.map((c) => `${c.startLine}-${c.endLine}`), ["1-120", "81-200"]);
  const index = buildSearchIndex(chunks);
  const hits = searchChunks(index, "needle", 5);
  assert.equal(hits.length, 1);
  assert.equal(`${hits[0].startLine}-${hits[0].endLine}`, "93-102");
  assert.equal(hits[0].snippet.split("\n").length, 10);
  assert.match(formatEvidencePacket(hits), /^LINES: 93-102$/m);
});

test("no two hits in one packet overlap or repeat a line range of the same file", () => {
  // Per 300-line file: windows 1-120, 81-200, 161-280, 241-300. Line 100 is
  // shared by the first two windows and line 250 by the last two.
  const marks = { 10: "needle", 100: "needle", 250: "needle" };
  const index = buildSearchIndex([
    ...fileChunks("src/a.ts", filler(300, marks)),
    ...fileChunks("src/b.ts", filler(300, marks)),
  ]);
  const hits = searchChunks(index, "needle", 50);
  const seen = headers(formatEvidencePacket(hits, 100000));
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.map((h) => h.n), [1, 2, 3, 4]);
  for (const path of ["src/a.ts", "src/b.ts"]) {
    const ranges = seen.filter((h) => h.path === path).sort((x, y) => x.start - y.start);
    assert.deepEqual(ranges.map((r) => `${r.start}-${r.end}`), ["8-102", "248-252"]);
    for (let i = 1; i < ranges.length; i++) {
      assert.ok(ranges[i].start > ranges[i - 1].end, `${path}: overlapping LINES ranges`);
    }
  }
});

test("every returned hit contains a query token", () => {
  const index = buildSearchIndex([
    ...fileChunks("src/a.ts", filler(300, { 10: "needle", 100: "needle", 250: "needle" })),
    { path: "src/b.ts", startLine: 1, endLine: 3, text: "needle\nx\ny" },
    { path: "src/c.ts", startLine: 1, endLine: 2, text: "nothing relevant\nat all" },
  ]);
  const hits = searchChunks(index, "needle", 50);
  assert.equal(hits.length, 3);
  for (const hit of hits) {
    assert.equal(hit.pathOnly, false);
    assert.ok(tokenize(hit.snippet).includes("needle"), `${hit.path} ${hit.startLine}-${hit.endLine} has no query token`);
  }
});

test("a chunk that matched only via its path becomes one pointer hit per file", () => {
  const index = buildSearchIndex([
    { path: "src/payments.ts", startLine: 1, endLine: 30, text: "export function charge() {}\nreturn total" },
    { path: "src/payments.ts", startLine: 31, endLine: 60, text: "helper\nmore helper" },
    { path: "src/billing.ts", startLine: 1, endLine: 2, text: "handles payments for invoices\nnext" },
  ]);
  const hits = searchChunks(index, "payments", 5);
  assert.equal(hits.length, 2);
  const pointer = hits.find((h) => h.path === "src/payments.ts");
  assert.equal(pointer.pathOnly, true);
  assert.equal(`${pointer.startLine}-${pointer.endLine}`, "1-60");
  assert.equal(
    pointer.snippet,
    "(matched on path only: no query token in lines 1-60; use read_snippet src/payments.ts 1 60 to view)",
  );
  const text = hits.find((h) => h.path === "src/billing.ts");
  assert.equal(text.pathOnly, false);
  assert.match(text.snippet, /payments/);
  assert.match(formatEvidencePacket(hits), /^LINES: 1-60$/m);
});

test("the path-only pointer is dropped when the same file has a text hit", () => {
  const index = buildSearchIndex([
    { path: "src/payments.ts", startLine: 1, endLine: 120, text: "no match in this window\nstill nothing" },
    { path: "src/payments.ts", startLine: 81, endLine: 200, text: "payments happen here\nend" },
  ]);
  const hits = searchChunks(index, "payments", 5);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].pathOnly, false);
  assert.equal(`${hits[0].startLine}-${hits[0].endLine}`, "81-82");
});

test("formatEvidencePacket keeps the whole packet within maxChars", () => {
  const hits = searchChunks(buildSearchIndex(wideChunks(6)), "alpha", 6);
  assert.equal(hits.length, 6);

  const unbounded = formatEvidencePacket(hits, 1_000_000);
  assert.ok(unbounded.length > DEFAULT_MAX_CHARS);
  assert.equal(headers(unbounded).length, 6);
  assert.doesNotMatch(unbounded, /budget:/);

  assert.ok(formatEvidencePacket(hits).length <= DEFAULT_MAX_CHARS);
  for (const maxChars of [DEFAULT_MAX_CHARS, 3000, 2000, 1000, 500]) {
    const packet = formatEvidencePacket(hits, maxChars);
    assert.ok(packet.length <= maxChars, `${packet.length} > ${maxChars}`);
    assert.match(packet, /^\[1\] FILE: src\/f0\.ts$/m);
    assert.match(packet, /budget:/);
    assert.match(packet, /read_snippet/);
  }
});

test("a hit that does not fit is cut at a line boundary with a recovery marker", () => {
  const hits = searchChunks(buildSearchIndex(wideChunks(1, 60)), "alpha", 1);
  const packet = formatEvidencePacket(hits, 1000);
  assert.ok(packet.length <= 1000);

  const lines = packet.split("\n");
  const markerAt = lines.findIndex((l) =>
    /^\.\.\. \(budget: \d+ chars omitted; use read_snippet src\/f0\.ts 1 60 to expand\)$/.test(l),
  );
  assert.ok(markerAt > 4, "marker follows at least one code line");
  assert.match(lines[markerAt - 1], /^alpha line \d+ x+$/);
  assert.deepEqual(lines.slice(markerAt + 1), ["```"]);

  const omitted = Number(lines[markerAt].match(/budget: (\d+) chars/)[1]);
  const shown = lines.slice(4, markerAt).join("\n").length;
  assert.equal(shown + omitted, hits[0].snippet.length);
});

test("hits after the budget are listed with their ranges", () => {
  const hits = searchChunks(buildSearchIndex(wideChunks(4)), "alpha", 4);
  const packet = formatEvidencePacket(hits, 2500);
  assert.ok(packet.length <= 2500);
  assert.equal(headers(packet).length, 2);
  assert.match(
    packet,
    /\n\n\.\.\. \(budget: 2 more hits omitted: src\/f2\.ts 1-30, src\/f3\.ts 1-30; use read_snippet <path> <start> <end> to expand, or raise maxChars\)$/,
  );
});

test("the cap marker names the first line that is not fully shown", () => {
  // 100 lines of 59 chars: line k (1-based) starts at offset 60*(k-1); the
  // 4000-char cap lands inside line 67 (offset 3960..4019).
  const text = Array.from({ length: 100 }, () => `alpha ${"x".repeat(53)}`).join("\n");
  const hits = searchChunks(buildSearchIndex([{ path: "src/big.ts", startLine: 1, endLine: 100, text }]), "alpha", 1);
  assert.equal(hits[0].truncated, true);
  assert.equal(hits[0].snippet.length, 4000);
  assert.equal(hits[0].snippet.split("\n").length, 67, "66 whole lines plus the start of line 67");
  assert.equal(hits[0].truncatedFromLine, 67);
  assert.equal(hits[0].endLine, 100);
  assert.match(formatEvidencePacket(hits), /\(truncated at 4000 chars; use read_snippet src\/big\.ts 67 100 to expand\)/);
});

test("the budget trailer always names an omitted hit when any hit is shown", () => {
  const hits = searchChunks(buildSearchIndex(wideChunks(6)), "alpha", 6);
  const full = formatEvidencePacket(hits, 1_000_000);
  let sawTrailer = 0;
  for (let maxChars = 200; maxChars < full.length; maxChars += 23) {
    const packet = formatEvidencePacket(hits, maxChars);
    assert.ok(packet.length <= maxChars, `${packet.length} > ${maxChars}`);
    const omitted = /budget: \d+ (?:more )?hits? omitted/.test(packet);
    if (headers(packet).length > 0 && omitted) {
      sawTrailer++;
      assert.match(packet, /hits? omitted: src\/f\d\.ts 1-30/, `bare-count trailer at maxChars=${maxChars}`);
      assert.doesNotMatch(packet, /omitted; raise maxChars/);
    }
  }
  assert.ok(sawTrailer > 50, "the sweep exercised the trailer path");
});
