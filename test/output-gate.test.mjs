import { test } from "node:test";
import assert from "node:assert/strict";

import { runTestFiltered, formatRunResult } from "../build/output-gate.js";

// These exercise the allowlist and output-filtering logic. They run `npm test`
// / `pytest` in a directory where those either fail fast or aren't configured,
// so they're quick and don't depend on a real suite.

test("reports resolved command and non-zero exit on missing npm script", async () => {
  const root = await import("node:fs").then(({ promises: fs }) =>
    import("node:os").then(({ tmpdir }) =>
      import("node:path").then(async ({ join }) => {
        const dir = await fs.mkdtemp(join(tmpdir(), "sniper-run-"));
        await fs.writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }), "utf8");
        return dir;
      }),
    ),
  );

  const res = await runTestFiltered(root, "npm_test");
  assert.equal(res.command, "npm_test");
  assert.equal(res.resolvedCommand, "npm test");
  assert.notEqual(res.exitCode, 0);
  assert.equal(res.timedOut, false);

  const out = formatRunResult(res);
  assert.match(out, /COMMAND: npm_test \(npm test\)/);
  assert.match(out, /EXIT CODE:/);
});

test("rejects commands outside the allowlist", async () => {
  await assert.rejects(() => runTestFiltered(process.cwd(), "rm_rf"), /Unsupported command/);
});

test("formatRunResult surfaces the timeout note", () => {
  const out = formatRunResult({
    command: "npm_test",
    resolvedCommand: "npm test",
    exitCode: null,
    filteredOutput: "boom",
    usedFallback: false,
    timedOut: true,
  });
  assert.match(out, /process timed out and was killed/);
  assert.match(out, /EXIT CODE: unknown/);
});

test("formatRunResult surfaces the fallback note", () => {
  const out = formatRunResult({
    command: "pytest",
    resolvedCommand: "pytest -q",
    exitCode: 0,
    filteredOutput: "raw tail",
    usedFallback: true,
    timedOut: false,
  });
  assert.match(out, /no error\/failure keywords matched/);
});
