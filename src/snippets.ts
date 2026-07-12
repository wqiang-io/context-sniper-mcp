import { promises as fs } from "node:fs";
import { resolveSafePath } from "./repo-index.js";

const MAX_LINES = 300;

export interface SnippetResult {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
  totalRequestedLines: number;
}

export async function readSnippet(
  root: string,
  relPath: string,
  startLine: number,
  endLine: number,
): Promise<SnippetResult> {
  if (startLine < 1) {
    throw new Error("startLine must be >= 1");
  }
  if (endLine < startLine) {
    throw new Error("endLine must be >= startLine");
  }

  const safePath = resolveSafePath(root, relPath);

  const stat = await fs.stat(safePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(`File not found: ${relPath}`);
  }

  const content = await fs.readFile(safePath, "utf8");
  const lines = content.split("\n");

  const requestedLines = endLine - startLine + 1;
  // The last line the caller could actually get, ignoring the cap: bounded by
  // the requested end and the end of the file.
  const availableEnd = Math.min(endLine, lines.length);
  const clampedEnd = Math.min(availableEnd, startLine + MAX_LINES - 1);
  // Only "truncated" when the 300-line cap withheld content that was otherwise
  // available — not when the range simply ran past the end of the file.
  const truncated = clampedEnd < availableEnd;

  const slice = lines.slice(startLine - 1, clampedEnd).join("\n");

  return {
    path: relPath,
    startLine,
    endLine: clampedEnd,
    text: slice,
    truncated,
    totalRequestedLines: requestedLines,
  };
}

export function formatSnippetResult(result: SnippetResult): string {
  const header = `FILE: ${result.path}\nLINES: ${result.startLine}-${result.endLine}`;
  const notice = result.truncated
    ? `\n(truncated to ${MAX_LINES} lines; requested ${result.totalRequestedLines} lines — narrow the range or call read_snippet again with a later startLine)`
    : "";
  return `${header}${notice}\n\`\`\`\n${result.text}\n\`\`\``;
}
