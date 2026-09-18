import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseIgnorePatterns, IgnoreMatcher, loadIgnoreMatcher, DEFAULT_IGNORE_PATTERNS } from "../build/ignore.js";

function matcher(text) {
  return new IgnoreMatcher(parseIgnorePatterns(text, "csignore"));
}

test("name patterns match files and directories at any depth", () => {
  const m = matcher("*.log\ntmp\n");
  assert.equal(m.ignores("a.log", false), true);
  assert.equal(m.ignores("deep/er/b.log", false), true);
  assert.equal(m.ignores("deep/tmp", true), true);
  assert.equal(m.ignores("deep/tmp", false), true); // no trailing slash: files too
  assert.equal(m.ignores("deep/tmp.txt", false), false);
  assert.equal(m.ignores("logs/notes.txt", false), false);
});

test("patterns containing a slash are anchored to the root", () => {
  const m = matcher("/README.md\nfrontend/dist\ndocs/*.md\n");
  assert.equal(m.ignores("README.md", false), true);
  assert.equal(m.ignores("sub/README.md", false), false);
  assert.equal(m.ignores("frontend/dist", true), true);
  assert.equal(m.ignores("other/frontend/dist", true), false);
  assert.equal(m.ignores("docs/a.md", false), true);
  assert.equal(m.ignores("docs/sub/a.md", false), false); // * stays within one segment
});

test("** crosses directories", () => {
  const m = matcher("**/generated\nsrc/**/*.snap\nfixtures/**\n");
  assert.equal(m.ignores("generated", true), true);
  assert.equal(m.ignores("a/b/generated", true), true);
  assert.equal(m.ignores("src/x.snap", false), true);
  assert.equal(m.ignores("src/a/b/x.snap", false), true);
  assert.equal(m.ignores("lib/x.snap", false), false);
  assert.equal(m.ignores("fixtures/a/b.json", false), true);
});

test("a trailing slash matches directories only", () => {
  const m = matcher("build/\n");
  assert.equal(m.ignores("build", true), true);
  assert.equal(m.ignores("build", false), false);
  assert.equal(m.ignores("pkg/build", true), true);
});

test("negation re-includes and the last matching rule wins", () => {
  const m = matcher("*.md\n!KEEP.md\n");
  assert.equal(m.ignores("a.md", false), true);
  assert.equal(m.ignores("docs/KEEP.md", false), false);
  const reversed = matcher("!KEEP.md\n*.md\n");
  assert.equal(reversed.ignores("KEEP.md", false), true);
});

test("blank lines, comments and trailing whitespace are ignored", () => {
  const rules = parseIgnorePatterns("# comment\n\n   \n*.tmp   \r\n", "csignore");
  assert.equal(rules.length, 1);
  assert.equal(new IgnoreMatcher(rules).ignores("x.tmp", false), true);
});

test("? and character classes work within one segment", () => {
  const m = matcher("file?.txt\n[ab]*.py\n");
  assert.equal(m.ignores("file1.txt", false), true);
  assert.equal(m.ignores("file12.txt", false), false);
  assert.equal(m.ignores("dir/file1.txt", false), true);
  assert.equal(m.ignores("alpha.py", false), true);
  assert.equal(m.ignores("beta.py", false), true);
  assert.equal(m.ignores("gamma.py", false), false);
});

test("default rules drop secrets, lockfiles and media but keep source and .env.example", () => {
  const m = new IgnoreMatcher(parseIgnorePatterns(DEFAULT_IGNORE_PATTERNS, "default"));
  const dirs = ["node_modules", "backend/__pycache__", "frontend/dist", ".context-index"];
  for (const d of dirs) assert.equal(m.ignores(d, true), true, d);
  const files = ["backend/.env", ".env.local", "uv.lock", "frontend/pnpm-lock.yaml", "a/b.svg", "app.min.js", "x.map", ".ssh/id_rsa", ".gitignore", ".csignore"];
  for (const f of files) assert.equal(m.ignores(f, false), true, f);
  const kept = [".env.example", "src/app.scss", "index.html", "Makefile", "backend/app/main.py", "src/keys.ts", "docs/guide.md"];
  for (const f of kept) assert.equal(m.ignores(f, false), false, f);
});

test("loadIgnoreMatcher layers .csignore over the defaults and reports the rule count", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sniper-ign-"));
  assert.equal((await loadIgnoreMatcher(root)).csignoreRules, null);

  await fs.writeFile(path.join(root, ".csignore"), "# mine\nREVIEW.md\n!dist/\n", "utf8");
  const { matcher: m, csignoreRules } = await loadIgnoreMatcher(root);
  assert.equal(csignoreRules, 2);
  assert.equal(m.ignores("REVIEW.md", false), true);
  assert.equal(m.match("REVIEW.md", false).source, "csignore");
  assert.equal(m.ignores("dist", true), false); // a default re-included by the project
  assert.equal(m.ignores("node_modules", true), true);
});
