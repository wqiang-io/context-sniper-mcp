import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readSnippet, formatSnippetResult } from "../build/snippets.js";
import { PathEscapeError } from "../build/repo-index.js";

async function makeRepo(lineCount) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-snip-"));
  const lines = Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`);
  await fs.writeFile(path.join(dir, "file.txt"), lines.join("\n"), "utf8");
  return dir;
}

test("reads an exact in-bounds range", async () => {
  const root = await makeRepo(50);
  const res = await readSnippet(root, "file.txt", 10, 12);
  assert.equal(res.text, "line 10\nline 11\nline 12");
  assert.equal(res.startLine, 10);
  assert.equal(res.endLine, 12);
  assert.equal(res.truncated, false);
});

test("range past end of file is NOT flagged as truncated (#7)", async () => {
  // File has 50 lines; requesting 1-500 returns all 50 and must not claim the
  // 300-line cap truncated anything.
  const root = await makeRepo(50);
  const res = await readSnippet(root, "file.txt", 1, 500);
  assert.equal(res.endLine, 50);
  assert.equal(res.truncated, false, "EOF clamp must not set truncated");
  assert.ok(!formatSnippetResult(res).includes("truncated"));
});

test("range wider than the 300-line cap IS flagged as truncated (#7)", async () => {
  const root = await makeRepo(1000);
  const res = await readSnippet(root, "file.txt", 1, 800);
  assert.equal(res.endLine, 300, "capped to 300 lines");
  assert.equal(res.truncated, true);
  assert.match(formatSnippetResult(res), /truncated to 300 lines; requested 800/);
});

test("cap boundary that coincides with EOF is not truncated", async () => {
  // Exactly 300 available lines, request exactly them -> no truncation.
  const root = await makeRepo(300);
  const res = await readSnippet(root, "file.txt", 1, 300);
  assert.equal(res.endLine, 300);
  assert.equal(res.truncated, false);
});

test("rejects paths that escape the root", async () => {
  const root = await makeRepo(5);
  await assert.rejects(() => readSnippet(root, "../../etc/passwd", 1, 3), PathEscapeError);
});

test("errors on invalid line ranges and missing files", async () => {
  const root = await makeRepo(5);
  await assert.rejects(() => readSnippet(root, "file.txt", 0, 3), /startLine must be >= 1/);
  await assert.rejects(() => readSnippet(root, "file.txt", 5, 2), /endLine must be >= startLine/);
  await assert.rejects(() => readSnippet(root, "nope.txt", 1, 3), /File not found/);
});
