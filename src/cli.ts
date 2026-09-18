import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { indexRepo, loadIndex, formatIndexResult, PathEscapeError } from "./repo-index.js";
import { searchChunks, formatEvidencePacket, DEFAULT_MAX_CHARS } from "./search.js";
import { readSnippet, formatSnippetResult } from "./snippets.js";
import { runTestFiltered, formatRunResult, type TestCommand } from "./output-gate.js";

const TEST_COMMANDS = ["npm_test", "pnpm_test", "pytest"] as const;

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
};

class UsageError extends Error {}

function readPackageVersion(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

const USAGE = `context-sniper-mcp <command> [args]

Commands:
  index <root>                                 Build a chunk index for a repo
  search <root> <query...> [--top-k N] [--max-chars N]   Search the index (default top-k 5, max-chars ${DEFAULT_MAX_CHARS})
  read <root> <path> <startLine> <endLine>      Read a line range from a file (capped at 300 lines)
  test <root> <npm_test|pnpm_test|pytest> [--timeout ms]   Run an allowlisted test command
  help [command]                                Show this help (or help for one command)
  --version, -v                                 Print the version

Run with no arguments to start the MCP stdio server instead.`;

const SUBCOMMAND_USAGE: Record<string, string> = {
  index: "Usage: context-sniper-mcp index <root>",
  search: "Usage: context-sniper-mcp search <root> <query...> [--top-k N] [--max-chars N]",
  read: "Usage: context-sniper-mcp read <root> <path> <startLine> <endLine>",
  test: "Usage: context-sniper-mcp test <root> <npm_test|pnpm_test|pytest> [--timeout ms]",
};

function parsePositiveInt(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(`${label} must be a positive integer, got: ${raw}`);
  }
  return n;
}

async function cmdIndex(args: string[], io: CliIo): Promise<number> {
  const root = args[0];
  if (!root) throw new UsageError(SUBCOMMAND_USAGE.index);

  const result = await indexRepo(root);
  io.stdout(formatIndexResult(result));
  return 0;
}

async function cmdSearch(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { "top-k": { type: "string", short: "k" }, "max-chars": { type: "string" } },
    allowPositionals: true,
  });

  const [root, ...queryParts] = positionals;
  const query = queryParts.join(" ");
  if (!root || !query) throw new UsageError(SUBCOMMAND_USAGE.search);

  let topK = 5;
  if (values["top-k"] !== undefined) {
    topK = parsePositiveInt(values["top-k"], "--top-k");
    if (topK > 50) throw new UsageError("--top-k must be at most 50");
  }

  let maxChars = DEFAULT_MAX_CHARS;
  if (values["max-chars"] !== undefined) {
    maxChars = parsePositiveInt(values["max-chars"], "--max-chars");
  }

  const index = await loadIndex(root);
  if (!index) {
    io.stderr(`No index found for this root. Run "context-sniper-mcp index ${root}" first.`);
    return 1;
  }

  const hits = searchChunks(index, query, topK);
  io.stdout(formatEvidencePacket(hits, maxChars));
  return 0;
}

async function cmdRead(args: string[], io: CliIo): Promise<number> {
  const [root, filePath, startRaw, endRaw] = args;
  if (!root || !filePath || startRaw === undefined || endRaw === undefined) {
    throw new UsageError(SUBCOMMAND_USAGE.read);
  }
  const startLine = parsePositiveInt(startRaw, "startLine");
  const endLine = parsePositiveInt(endRaw, "endLine");

  const result = await readSnippet(root, filePath, startLine, endLine);
  io.stdout(formatSnippetResult(result));
  return 0;
}

async function cmdTest(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { timeout: { type: "string" } },
    allowPositionals: true,
  });

  const [root, command] = positionals;
  if (!root || !command) throw new UsageError(SUBCOMMAND_USAGE.test);
  if (!(TEST_COMMANDS as readonly string[]).includes(command)) {
    throw new UsageError(`Unknown command "${command}". ${SUBCOMMAND_USAGE.test}`);
  }

  const timeoutMs = values.timeout !== undefined ? parsePositiveInt(values.timeout, "--timeout") : undefined;
  const result = await runTestFiltered(root, command as TestCommand, timeoutMs);
  io.stdout(formatRunResult(result));

  if (result.timedOut) return 124;
  if (result.exitCode === null) return 1;
  return result.exitCode;
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv;

  try {
    switch (command) {
      case "index":
        return await cmdIndex(rest, io);
      case "search":
        return await cmdSearch(rest, io);
      case "read":
        return await cmdRead(rest, io);
      case "test":
        return await cmdTest(rest, io);
      case "help":
      case "--help":
      case "-h": {
        const topic = rest[0];
        io.stdout(topic && SUBCOMMAND_USAGE[topic] ? SUBCOMMAND_USAGE[topic] : USAGE);
        return 0;
      }
      case "--version":
      case "-v":
        io.stdout(readPackageVersion());
        return 0;
      default:
        io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(err.message);
      return 2;
    }
    if (err instanceof PathEscapeError) {
      io.stderr(`Refused: ${err.message}. Only paths inside root are allowed.`);
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}`);
    return 1;
  }
}
