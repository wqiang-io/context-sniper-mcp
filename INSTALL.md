# Install & configure context-sniper-mcp

English | [简体中文](./INSTALL.zh-CN.md)

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

## Use it as a CLI

The same entry point doubles as a plain command-line tool — passing a known
subcommand (`index`, `search`, `read`, `test`, `help`) or flag (`--version`)
runs it once and exits, instead of starting the MCP server:

```bash
node build/index.js index .
node build/index.js search . "some query" --top-k 3
node build/index.js read . src/index.ts 1 40
node build/index.js test . npm_test
```

This also works through the `context-sniper-mcp` bin name once installed
(`npm link`, a global install, or the shared launcher below), and through the
launcher script since it forwards `"$@"`. See [README.md](./README.md#cli-usage)
for the full subcommand reference.

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

## Add to DeepSeek Harness

[DeepSeek Harness](https://www.deepseek.com/harness/en/) (`dsh`) registers MCP
servers through its Cordis plugin system, via the `@deepseek-ai/dsh-mcp-client`
plugin, configured in a YAML patch file. Add an entry to
`$DSH_HOME/cordis.patch.yml` (create it if it doesn't exist yet):

```yaml
- id: context-sniper
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: context-sniper
    transport: stdio
    command: node
    args: ['/ABS/PATH/context-sniper-mcp/build/index.js']
```

Replace `/ABS/PATH` with the absolute path to this project. Tools then show up
as `mcp__context-sniper__index_repo`, `mcp__context-sniper__search_code`, etc.

To test a patch without persisting it first, pass it directly on the command
line instead:

```bash
dsh web --patch "/ABS/PATH/to/your/patch.cordis.yml"
```

See the [mcp-client README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)
for the full set of options (`cwd`, `toolCallTimeoutMs`, `failOnStartupError`, etc.).

### Shared launcher (recommended)

Instead of hardcoding the absolute build path in every client config, install
a one-line launcher script on `PATH` and point each client at the bare
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

**DeepSeek Harness** (`$DSH_HOME/cordis.patch.yml`):

```yaml
- id: context-sniper
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: context-sniper
    transport: stdio
    command: context-sniper-mcp
    args: []
```

Rebuilding the project (`npm run build`) is picked up automatically — the
launcher always `cd`s into the project and runs the current `build/index.js`,
so neither client config needs to change again.
