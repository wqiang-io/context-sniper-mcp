# Install & configure context-sniper-mcp

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
