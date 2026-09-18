# context-sniper-mcp

English | [简体中文](./README.zh-CN.md)

A tiny local MCP server that indexes a repository into line-range chunks and
serves compact "evidence packets" (file + lines + score + snippet) instead of
dumping whole files into the model's context. Meant to be shared by
Claude Code and Codex to cut token usage when exploring or debugging a repo.

No database — the index is a single JSON file written to
`<repo>/.context-index/chunks.json`.

## Tools

- **index_repo** `{ root }` — scans `root`, chunks every text file into
  ~80-line sliding windows (max 120 lines/chunk), and writes
  `root/.context-index/chunks.json`. There is no extension allowlist: `.scss`,
  `.html`, `.vue`, `.sh`, `Makefile` and so on are all searchable. Files are
  skipped by a built-in gitignore-style rule set (`node_modules`, `.git`,
  `dist`, `build`, `.next`, `coverage`, `.venv`, `target`, `__pycache__`,
  lockfiles, `*.min.*`, source maps, `.env*` secrets, media and archives), by
  `root/.csignore` (see below), by a NUL-byte binary check, and by a
  512&nbsp;KB size cap.
- **search_code** `{ root, query, topK?, maxChars? }` — loads the chunk index
  and scores it against `query` with a BM25-style ranker. `topK` (default 5,
  max 50) bounds the candidate chunks; `maxChars` (default 6000) bounds the
  whole reply. Hits are trimmed to the lines that matched, merged when they
  overlap, and returned as `FILE` / `LINES` / `SCORE` + code block; see
  "Evidence packets and the output budget" below for the exact shape. If no
  index exists yet, it tells you to run `index_repo` first.
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

## Ignoring files (`.csignore`)

Put a `.csignore` file in the repo root to keep files out of the index. It uses
gitignore syntax: blank lines and `#` comments are skipped; `*` matches within
one path segment, `?` one character, `**` any number of segments, `[abc]` a
character class; a pattern without `/` matches a file or directory name at any
depth; a pattern containing `/` is anchored to the root (a leading `/` is
optional); a trailing `/` matches directories only; `!` re-includes something
an earlier rule or a built-in default excluded, and the last matching rule
wins. Not supported: `\` escapes and nested ignore files.

```
# .csignore
REVIEW.md
.claude/
docs/**/*.snap
!dist/
```

`.gitignore` is deliberately not read: version-control noise and search noise
differ (a `.gitignore` that hides a nested backend repo should not hide it from
search). Re-run `index_repo` after editing `.csignore`; the result reports how
many rules were read and how many files or directories they skipped.

## Evidence packets and the output budget

`search_code` never returns whole chunks. For each of the `topK` candidate
chunks it keeps only the lines containing a query token, plus 2 lines of
context on each side; candidates from the same file whose trimmed ranges
overlap or touch are merged into one hit. So fewer than `topK` hits can come
back, and no line range is returned twice. A hit looks like this:

````
[1] FILE: src/output-gate.ts
LINES: 48-74
SCORE: 13.216
```
        cwd: root,
        shell: false,
        env: process.env,
        // Run in its own process group so a timeout can reap the whole tree
        // (e.g. npm -> node -> test worker), not just the direct child.
        detached: true,
... (lines 54-63 omitted)
    const timer = setTimeout(() => {
      timedOutFlag = true;
      // Negative pid targets the whole process group (created via detached).
```
````

`LINES` is the span of the trimmed hit. Every stretch inside that span that is
not shown is marked in the block:

- `... (lines A-B omitted)` — lines between two matching regions.
- `... (truncated at 4000 chars; use read_snippet <path> <line> <end> to expand)`
  — one hit exceeded the per-hit cap; reading resumes at `<line>`.
- `... (budget: N chars omitted; use read_snippet <path> <start> <end> to expand)`
  — the packet's `maxChars` budget ran out inside this hit (cut at a line
  boundary).

A chunk that matched only through its path (say the query `payments` against
`src/payments.ts`, whose text never contains that word) is returned as a
one-line pointer instead of code, and only when the file has no text hit in
the packet:

````
[3] FILE: src/payments.ts
LINES: 1-60
SCORE: 2.1
```
(matched on path only: no query token in lines 1-60; use read_snippet src/payments.ts 1 60 to view)
```
````

The whole packet is capped at `maxChars` (default 6000, about 1.5k tokens).
Hits are added in score order; the first one that does not fit is cut as
described above, and the remaining hits are listed at the end so they can
still be fetched:

```
... (budget: 3 more hits omitted: src/cli.ts 81-172, README.zh-CN.md 84-88, README.md 51-62; use read_snippet <path> <start> <end> to expand, or raise maxChars)
```

Whenever at least one hit is shown, that trailer names at least one omitted
hit. Raise `maxChars`, or narrow the query, to see more of them. A reply of
`No matching chunks found.` means no chunk contained any query token: the
tokenizer lowercases, splits on anything other than letters, digits and `_`,
drops single characters, and does not split camelCase, so `handleSubmit` is
one token.

## Installation

For installation and client configuration, see [INSTALL.md](./INSTALL.md).

## CLI usage

The same binary also works as a plain shell command — pass a subcommand and it
runs once and exits, instead of starting the MCP stdio server:

```bash
context-sniper-mcp index <root>
context-sniper-mcp search <root> <query...> [--top-k N] [--max-chars N]
context-sniper-mcp read <root> <path> <startLine> <endLine>
context-sniper-mcp test <root> <npm_test|pnpm_test|pytest> [--timeout ms]
context-sniper-mcp help
context-sniper-mcp --version
```

Each subcommand maps 1:1 to the tool of the same purpose above and prints the
same human-readable output. `test` exits with the underlying test command's
own exit code (or `124` on timeout), so it's usable in scripts, e.g.
`context-sniper-mcp test . npm_test || echo "tests failed"`. Running the
binary with no arguments still starts the MCP stdio server.

## Recommended usage

1. Call **index_repo** once per repo (and again after large changes) before
   doing anything else.
2. Before fixing a bug, prefer **search_code** over opening files — search
   for the symptom, error message, or function name first.
3. Don't read a whole file up front. Let the evidence packet from
   `search_code` tell you where to look.
4. If a test fails, use **run_test_filtered** to get the trimmed
   failure output instead of piping raw test-runner logs into context.
5. If a hit ends with an omission marker, follow it: the marker spells out
   the exact **read_snippet** call (`<path> <start> <end>`, still capped at
   300 lines per call) rather than reading the entire file. Raise `maxChars`
   only when the trailer lists several omitted hits you actually need.

## Using it from CLAUDE.md / AGENTS.md

Paste this into the project's `CLAUDE.md` or `AGENTS.md` so the agent reaches
for Context Sniper before it reaches for `Read`. Every line here is loaded on
every turn, so it is kept short; the tool descriptions the server ships carry
the rest.

```markdown
## Context Sniper

This repo is served by the `context-sniper` MCP server. Use it to locate code
before opening files: one `search_code` reply is capped at 6000 chars (about
1.5k tokens) and returns only the matching lines plus 2 lines of context.

Tools (`root` is always this repo's absolute path):
- `index_repo(root)` — run it if `.context-index/` is missing, and again after
  `git pull`, large edits, or a change to `.csignore`. If a snippet's line
  numbers no longer match the file, the index is stale: re-run it.
- `search_code(root, query, topK?, maxChars?)` — keyword search (BM25), not
  semantic. Query with identifiers, error strings and distinctive words as they
  appear in the code; camelCase is one token and single characters are dropped.
  Start with the defaults. Raise `topK` for broad queries; raise `maxChars` only
  when the trailer lists omitted hits you actually need.
- `read_snippet(root, path, startLine, endLine)` — bounded read, 300 lines max.
  Every omission marker in a search result spells out the exact call: copy it
  instead of reading the whole file.
- `run_test_filtered(root, command)` — `npm_test` / `pnpm_test` / `pytest`;
  returns only the failure-relevant lines.

Workflow:
1. Locate with `search_code`; expand with `read_snippet` by following the markers.
2. Read a whole file only when you are about to edit it or it is short. `Grep`
   is still right for exact strings, regexes, and files added since the last index.
3. After editing, verify with `run_test_filtered` instead of the raw test runner.
```

## Token efficiency

Measured on 2026-09-19; tokens are estimated as characters ÷ 4. "Before" is the
previous `search_code`, which returned whole chunks; "after" is the current
default (`topK` 5, `maxChars` 6000).

| Query | Corpus | Before | After |
|-------|--------|--------|-------|
| `timeout kill process group` | this repo (13 files) | 14,279 chars ≈ 3.6k tokens | 2,907 chars ≈ 0.7k tokens |
| `index`, `topK` 50 | this repo | 53,010 chars ≈ 13k tokens | 5,992 chars ≈ 1.5k tokens (budget cap) |
| `__table_name__` | a React + FastAPI project (69 files) | 8,697 chars | 914 chars |
| `zustand persist sidebar` | same project | 14,637 chars | 2,912 chars |

For scale: `grep -rn SIGKILL src/` is 207 chars, and a plain `Read` of one
120-line file is roughly 4,000 to 5,000 chars. A search reply never exceeds
`maxChars`; whatever was cut can be fetched with the `read_snippet` call named
in the marker.

## Design notes

- **Atomic index writes** — `index_repo` writes to a temp file next to the
  index and `rename()`s it into place, so a concurrent `search_code` never sees
  a half-written file. The index carries a format version (currently 2); a
  file with any other version is treated as missing, and `search_code` asks you
  to re-run `index_repo`.
- **Per-process cache** — a loaded index is cached by path and mtime for the
  life of the server process, so repeated searches don't re-parse the JSON; the
  cache drops the entry when the file changes.
- **No arbitrary execution** — `read_snippet` resolves `path` against `root`
  and refuses anything that escapes it; the test runner spawns with
  `shell: false` and a fixed allowlist.

## Project layout

```
context-sniper-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # MCP server wiring + tool registration; dispatches to cli.ts
│   ├── cli.ts          # shell subcommands (index/search/read/test) for direct CLI use
│   ├── repo-index.ts   # scanning, chunking, safe path resolution, index I/O
│   ├── ignore.ts       # gitignore-style rules: built-in defaults + .csignore
│   ├── search.ts       # BM25-style scoring + evidence packet formatting
│   ├── snippets.ts     # bounded, path-safe line-range reads
│   ├── output-gate.ts  # allowlisted test runner + output filtering
│   └── tokenize.ts     # shared tokenizer used by indexing + search
├── test/                 # *.test.mjs unit tests for each src module
├── build/                # compiled output (npm run build)
├── INSTALL.md
├── INSTALL.zh-CN.md
├── README.md
└── README.zh-CN.md
```

## License

MIT
