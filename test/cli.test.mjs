import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../build/cli.js";

function collectingIo() {
  const stdout = [];
  const stderr = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

async function makeFixtureRepo() {
  const dir = await fs.mkdtemp(join(tmpdir(), "sniper-cli-"));
  await fs.writeFile(join(dir, "hello.js"), "function hello() {\n  return 'world';\n}\n", "utf8");
  return dir;
}

test("index writes an index and reports counts", async () => {
  const root = await makeFixtureRepo();
  const { io, stdout } = collectingIo();

  const code = await runCli(["index", root], io);
  assert.equal(code, 0);
  assert.match(stdout.join("\n"), /Indexed 1 files into 1 chunks/);

  const stat = await fs.stat(join(root, ".context-index", "chunks.json"));
  assert.ok(stat.isFile());
});

test("search before indexing reports no index and exits 1", async () => {
  const root = await makeFixtureRepo();
  const { io, stderr } = collectingIo();

  const code = await runCli(["search", root, "hello"], io);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /No index found/);
});

test("search after indexing returns an evidence packet", async () => {
  const root = await makeFixtureRepo();
  await runCli(["index", root], collectingIo().io);

  const { io, stdout } = collectingIo();
  const code = await runCli(["search", root, "hello", "world"], io);
  assert.equal(code, 0);
  assert.match(stdout.join("\n"), /FILE: hello\.js/);
});

test("read returns a snippet for a valid range", async () => {
  const root = await makeFixtureRepo();
  const { io, stdout } = collectingIo();

  const code = await runCli(["read", root, "hello.js", "1", "2"], io);
  assert.equal(code, 0);
  assert.match(stdout.join("\n"), /LINES: 1-2/);
});

test("read refuses a path that escapes root", async () => {
  const root = await makeFixtureRepo();
  const { io, stderr } = collectingIo();

  const code = await runCli(["read", root, "../outside.js", "1", "2"], io);
  assert.equal(code, 1);
  assert.match(stderr.join("\n"), /Refused:/);
});

test("read with a non-numeric line is a usage error", async () => {
  const root = await makeFixtureRepo();
  const { io, stderr } = collectingIo();

  const code = await runCli(["read", root, "hello.js", "nope", "2"], io);
  assert.equal(code, 2);
  assert.match(stderr.join("\n"), /startLine must be a positive integer/);
});

test("test subcommand passes through the runner's exit code", async () => {
  const root = await makeFixtureRepo();
  await fs.writeFile(join(root, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }), "utf8");

  const { io, stdout } = collectingIo();
  const code = await runCli(["test", root, "npm_test"], io);
  assert.notEqual(code, 0);
  assert.match(stdout.join("\n"), /COMMAND: npm_test/);
});

test("help and version print non-empty output and exit 0", async () => {
  const help = collectingIo();
  assert.equal(await runCli(["--help"], help.io), 0);
  assert.ok(help.stdout.join("\n").length > 0);

  const version = collectingIo();
  assert.equal(await runCli(["--version"], version.io), 0);
  assert.match(version.stdout.join("\n"), /^\d+\.\d+\.\d+$/);
});

test("unknown command exits 2", async () => {
  const { io, stderr } = collectingIo();
  const code = await runCli(["bogus"], io);
  assert.equal(code, 2);
  assert.match(stderr.join("\n"), /Unknown command/);
});
