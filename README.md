# context-sniper-mcp

A tiny local MCP server that indexes a repository into line-range chunks and
serves compact "evidence packets" (file + lines + score + snippet) instead of
dumping whole files into the model's context. Meant to be shared by
Claude Code and Codex to cut token usage when exploring or debugging a repo.

No database — the index is a single JSON file written to
`<repo>/.context-index/chunks.json`.

## Tools

- **index_repo** `{ root }` — scans `root` (skipping `node_modules`, `.git`,
  `dist`, `build`, `.next`, `coverage`, `.venv`, `target`), chunks supported
  files (`ts tsx js jsx py java go rs md json yml yaml toml`) into ~80-line
  sliding windows (max 120 lines/chunk), and writes
  `root/.context-index/chunks.json`. Dependency lockfiles
  (`package-lock.json`, `pnpm-lock.yaml`, `npm-shrinkwrap.json`), minified
  bundles (`*.min.js`, `*.bundle.js`), and files larger than 512&nbsp;KB are
  skipped so the index stays focused on real source.
- **search_code** `{ root, query, topK? }` — loads the chunk index and scores
  it against `query` with a BM25-style ranker. Returns up to `topK` (default
  5) hits, each with `FILE`, `LINES`, `SCORE`, and a snippet capped at 4000
  characters. If no index exists yet, it tells you to run `index_repo` first.
- **read_snippet** `{ root, path, startLine, endLine }` — reads an explicit
  line range from one file inside `root`. Capped at 300 lines per call (longer
  ranges are truncated with a note). `path` is resolved and checked against
  `root`; anything that would escape `root` is refused.
- **run_test_filtered** `{ root, command }` — runs one of a fixed allowlist of
  commands (`npm_test` → `npm test`, `pnpm_test` → `pnpm test`, `pytest` →
  `pytest -q`) via `spawn` with `shell: false` — no arbitrary shell execution.
  Captures stdout/stderr, keeps only lines matching
  `error|failed|failure|assert|expected|received|traceback` or a test-file
  path, tail-capped at 120 lines. If nothing matches, falls back to the last
  80 raw output lines. Always reports the resolved command and exit code.

There is intentionally no `run_shell` or equivalent — only the four tools
above are exposed.

## Install & build

```bash
cd context-sniper-mcp
npm install
npm run build        # compiles src/ -> build/
```

Run it directly (mostly useful for a manual stdio smoke test — a real client
like Claude Code or Codex will launch it for you):

```bash
node build/index.js
```

The server speaks MCP over stdio. It never writes anything to stdout except
protocol messages — all logs go to stderr — so it's safe to pipe.

## Add to Claude Code

```bash
claude mcp add --scope user --transport stdio context-sniper -- node /ABS/PATH/context-sniper-mcp/build/index.js
```

Replace `/ABS/PATH` with the absolute path to this project (e.g. output of
`pwd` inside `context-sniper-mcp`).

## Add to Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.context_sniper]
command = "node"
args = ["/ABS/PATH/context-sniper-mcp/build/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

### Shared launcher (recommended)

Instead of hardcoding the absolute build path in every client config, install
a one-line launcher script on `PATH` and point both clients at the bare
command name:

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/context-sniper-mcp << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/ABS/PATH/context-sniper-mcp"

cd "$PROJECT_DIR"
exec node build/index.js "$@"
EOF
chmod +x ~/.local/bin/context-sniper-mcp
```

Make sure `~/.local/bin` is on `PATH` (`echo $PATH | tr ':' '\n' | grep .local/bin`).
Then:

**Claude Code:**

```bash
claude mcp add --scope user --transport stdio context-sniper -- context-sniper-mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.context_sniper]
command = "context-sniper-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

Rebuilding the project (`npm run build`) is picked up automatically — the
launcher always `cd`s into the project and runs the current `build/index.js`,
so neither client config needs to change again.

## Recommended usage

1. Call **index_repo** once per repo (and again after large changes) before
   doing anything else.
2. Before fixing a bug, prefer **search_code** over opening files — search
   for the symptom, error message, or function name first.
3. Don't read a whole file up front. Let the evidence packet from
   `search_code` tell you where to look.
4. If a test fails, use **run_test_filtered** to get the trimmed
   failure output instead of piping raw test-runner logs into context.
5. If a returned snippet cuts off before the context you need, use
   **read_snippet** with a widened `startLine`/`endLine` range around it
   (still capped at 300 lines per call) rather than reading the entire file.

## Project layout

```
context-sniper-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # MCP server wiring + tool registration
│   ├── repo-index.ts    # scanning, chunking, safe path resolution, index I/O
│   ├── search.ts         # BM25-style scoring + evidence packet formatting
│   ├── snippets.ts       # bounded, path-safe line-range reads
│   └── output-gate.ts    # allowlisted test runner + output filtering
├── build/                # compiled output (npm run build)
└── README.md
```
