#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { indexRepo, loadIndex, formatIndexResult, PathEscapeError } from "./repo-index.js";
import { searchChunks, formatEvidencePacket, DEFAULT_MAX_CHARS } from "./search.js";
import { readSnippet, formatSnippetResult } from "./snippets.js";
import { runTestFiltered, formatRunResult, type TestCommand } from "./output-gate.js";

function log(...args: unknown[]): void {
  // stdout is reserved for the MCP protocol stream; all diagnostics go to stderr.
  console.error("[context-sniper-mcp]", ...args);
}

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    isError,
  };
}

function errorResult(err: unknown) {
  if (err instanceof PathEscapeError) {
    return textResult(`Refused: ${err.message}. Only paths inside root are allowed.`, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  return textResult(`Error: ${message}`, true);
}

const server = new McpServer({
  name: "context-sniper-mcp",
  version: "0.1.0",
});

server.registerTool(
  "index_repo",
  {
    title: "Index repo",
    description:
      "Scan a repository and build a lightweight chunk index at <root>/.context-index/chunks.json. " +
      "Run this once before search_code (and re-run after significant code changes).",
    inputSchema: {
      root: z.string().describe("Absolute path to the repository root"),
    },
  },
  async ({ root }) => {
    try {
      const result = await indexRepo(root);
      return textResult(formatIndexResult(result));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "search_code",
  {
    title: "Search code",
    description:
      "Search the previously built chunk index with a BM25-style keyword score and return a compact evidence " +
      "packet (FILE / LINES / SCORE + snippet) instead of full files. Each hit is trimmed to the lines containing " +
      "query tokens plus 2 lines of context, overlapping hits from the same file are merged, and the whole packet " +
      "is capped at maxChars; hits that do not fit are listed so they can be fetched with read_snippet. " +
      "Call index_repo first if no index exists.",
    inputSchema: {
      root: z.string().describe("Absolute path to the repository root"),
      query: z.string().describe("Natural language or keyword query"),
      topK: z.number().int().positive().max(50).optional()
        .describe("Max candidate chunks to consider (default 5); fewer hits can come back after trimming and merging"),
      maxChars: z.number().int().positive().optional()
        .describe(`Total character budget for the whole evidence packet (default ${DEFAULT_MAX_CHARS}); hits are added in score order and the rest are listed as omitted`),
    },
  },
  async ({ root, query, topK, maxChars }) => {
    try {
      const index = await loadIndex(root);
      if (!index) {
        return textResult(
          "No index found for this root. Call index_repo with this root first, then retry search_code.",
          true,
        );
      }
      const hits = searchChunks(index, query, topK ?? 5);
      return textResult(formatEvidencePacket(hits, maxChars ?? DEFAULT_MAX_CHARS));
    } catch (err) {
      return errorResult(err);
    }
  },
);

server.registerTool(
  "read_snippet",
  {
    title: "Read snippet",
    description:
      "Read an explicit line range from a single file inside root. Use this only after search_code narrows down " +
      "a location and the returned snippet isn't enough context. Capped at 300 lines per call.",
    inputSchema: {
      root: z.string().describe("Absolute path to the repository root"),
      path: z.string().describe("File path, relative to root (or absolute, but must resolve inside root)"),
      startLine: z.number().int().positive().describe("1-based start line, inclusive"),
      endLine: z.number().int().positive().describe("1-based end line, inclusive"),
    },
  },
  async ({ root, path: filePath, startLine, endLine }) => {
    try {
      const result = await readSnippet(root, filePath, startLine, endLine);
      return textResult(formatSnippetResult(result));
    } catch (err) {
      return errorResult(err);
    }
  },
);

const TEST_COMMANDS = ["npm_test", "pnpm_test", "pytest"] as const;

server.registerTool(
  "run_test_filtered",
  {
    title: "Run test (filtered)",
    description:
      "Run one of a fixed allowlist of test commands (no arbitrary shell) and return only the filtered " +
      "failure-relevant output: command, exit code, and lines matching error/failed/assert/expected/traceback/" +
      "test-file-path, tail-capped at 120 lines (falls back to last 80 raw lines if nothing matches).",
    inputSchema: {
      root: z.string().describe("Absolute path to the repository root"),
      command: z.enum(TEST_COMMANDS).describe("One of: npm_test, pnpm_test, pytest"),
    },
  },
  async ({ root, command }) => {
    try {
      const result = await runTestFiltered(root, command as TestCommand);
      return textResult(formatRunResult(result));
    } catch (err) {
      return errorResult(err);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("context-sniper-mcp running on stdio");
}

const CLI_SUBCOMMANDS = new Set(["index", "search", "read", "test", "help", "--help", "-h", "--version", "-v"]);

if (CLI_SUBCOMMANDS.has(process.argv[2])) {
  const { runCli } = await import("./cli.js");
  const code = await runCli(process.argv.slice(2));
  process.exit(code);
} else {
  main().catch((err) => {
    log("fatal error during startup:", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}

process.on("uncaughtException", (err) => {
  log("uncaughtException:", err instanceof Error ? err.stack ?? err.message : err);
});

process.on("unhandledRejection", (reason) => {
  log("unhandledRejection:", reason instanceof Error ? reason.stack ?? reason.message : reason);
});
