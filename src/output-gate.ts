import { spawn } from "node:child_process";

export type TestCommand = "npm_test" | "pnpm_test" | "pytest";

const COMMAND_MAP: Record<TestCommand, { cmd: string; args: string[] }> = {
  npm_test: { cmd: "npm", args: ["test"] },
  pnpm_test: { cmd: "pnpm", args: ["test"] },
  pytest: { cmd: "pytest", args: ["-q"] },
};

const MAX_BUFFER_BYTES = 5 * 1024 * 1024; // 5MB safety cap per stream
const FILTERED_TAIL_LINES = 120;
const RAW_FALLBACK_TAIL_LINES = 80;

const KEYWORD_RE = /\b(error|failed|failure|assert(ion)?|expected|received|traceback)\b/i;
const TEST_FILE_RE = /[\w./\\-]+\.(test|spec)\.[jt]sx?|[\w./\\-]+_test\.py|[\w./\\-]+\.py:\d+|[\w./\\-]+\.(ts|tsx|js|jsx|java|go|rs):\d+/i;

export interface RunResult {
  command: TestCommand;
  resolvedCommand: string;
  exitCode: number | null;
  filteredOutput: string;
  usedFallback: boolean;
  timedOut: boolean;
}

export async function runTestFiltered(
  root: string,
  command: TestCommand,
  timeoutMs = 5 * 60 * 1000,
): Promise<RunResult> {
  const spec = COMMAND_MAP[command];
  if (!spec) {
    throw new Error(`Unsupported command: ${command}`);
  }

  const { cmd, args } = spec;

  const { stdout, stderr, exitCode, timedOut } = await new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }>((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: root,
        shell: false,
        env: process.env,
        // Run in its own process group so a timeout can reap the whole tree
        // (e.g. npm -> node -> test worker), not just the direct child.
        detached: true,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOutFlag = false;

    const timer = setTimeout(() => {
      timedOutFlag = true;
      // Negative pid targets the whole process group (created via detached).
      // Fall back to killing just the child if the group kill fails.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_BUFFER_BYTES) stdoutBuf += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_BUFFER_BYTES) stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code, timedOut: timedOutFlag });
    });
  });

  const combined = [
    stdout ? `--- stdout ---\n${stdout}` : "",
    stderr ? `--- stderr ---\n${stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const lines = combined.split("\n");
  const matched = lines.filter((line) => KEYWORD_RE.test(line) || TEST_FILE_RE.test(line));

  let filteredOutput: string;
  let usedFallback = false;

  if (matched.length > 0) {
    filteredOutput = matched.slice(-FILTERED_TAIL_LINES).join("\n");
  } else {
    usedFallback = true;
    filteredOutput = lines.slice(-RAW_FALLBACK_TAIL_LINES).join("\n");
  }

  return {
    command,
    resolvedCommand: `${cmd} ${args.join(" ")}`,
    exitCode,
    filteredOutput,
    usedFallback,
    timedOut,
  };
}

export function formatRunResult(result: RunResult): string {
  const timeoutNote = result.timedOut ? "\n(process timed out and was killed)" : "";
  const fallbackNote = result.usedFallback
    ? "\n(no error/failure keywords matched; showing last 80 lines of raw output)"
    : "";

  return [
    `COMMAND: ${result.command} (${result.resolvedCommand})`,
    `EXIT CODE: ${result.exitCode === null ? "unknown" : result.exitCode}`,
    `${timeoutNote}${fallbackNote}`.trim(),
    "```",
    result.filteredOutput || "(no output captured)",
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}
