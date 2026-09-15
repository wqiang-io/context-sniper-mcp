# 安装与配置 context-sniper-mcp

[English](./INSTALL.md) | 简体中文

## 安装与构建

```bash
cd context-sniper-mcp
npm install
npm run build        # 将 src/ 编译到 build/
```

直接运行（主要用于手动做 stdio 冒烟测试——实际使用时，Claude Code、Codex
或 DeepSeek Harness 这类客户端会自动帮你启动它）：

```bash
node build/index.js
```

该服务器通过 stdio 使用 MCP 协议通信。除了协议消息外，它不会向 stdout
输出任何内容——所有日志都写到 stderr——所以可以安全地通过管道使用。

## 作为命令行工具使用

同一个入口文件也可以直接当作普通命令行工具——传入已知的子命令
（`index`、`search`、`read`、`test`、`help`）或 `--version` 参数时，会执行
一次后退出，而不会启动 MCP 服务器：

```bash
node build/index.js index .
node build/index.js search . "some query" --top-k 3
node build/index.js read . src/index.ts 1 40
node build/index.js test . npm_test
```

安装后（`npm link`、全局安装，或使用下方的共享启动脚本），通过
`context-sniper-mcp` 这个 bin 名字也能这样用；启动脚本本身因为透传了
`"$@"`，同样支持子命令。完整的子命令说明见
[README.md](./README.md#cli-usage)。

## 接入 Claude Code

```bash
claude mcp add --scope user --transport stdio context-sniper -- node /ABS/PATH/context-sniper-mcp/build/index.js
```

将 `/ABS/PATH` 替换为本项目的绝对路径（例如在 `context-sniper-mcp` 目录下
执行 `pwd` 的输出）。

## 接入 Codex

添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.context_sniper]
command = "node"
args = ["/ABS/PATH/context-sniper-mcp/build/index.js"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

## 接入 DeepSeek Harness

[DeepSeek Harness](https://www.deepseek.com/harness/en/)（`dsh`）通过其
Cordis 插件体系接入 MCP 服务器，具体是通过 `@deepseek-ai/dsh-mcp-client`
插件，在一个 YAML patch 文件里配置。在
`$DSH_HOME/cordis.patch.yml` 中新增一项（如果文件不存在就新建）：

```yaml
- id: context-sniper
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: context-sniper
    transport: stdio
    command: node
    args: ['/ABS/PATH/context-sniper-mcp/build/index.js']
```

将 `/ABS/PATH` 替换为本项目的绝对路径。之后工具会以
`mcp__context-sniper__index_repo`、`mcp__context-sniper__search_code` 等
名称出现。

如果想先临时测试某个 patch、暂不持久化，可以直接通过命令行传入：

```bash
dsh web --patch "/ABS/PATH/to/your/patch.cordis.yml"
```

更多可选配置项（`cwd`、`toolCallTimeoutMs`、`failOnStartupError` 等）见
[mcp-client 的 README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)。

### 共享启动脚本（推荐）

与其在每个客户端配置里都硬编码构建产物的绝对路径，不如安装一个一行的
启动脚本到 `PATH` 上，让每个客户端都指向这个简单的命令名：

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

确保 `~/.local/bin` 在 `PATH` 中（`echo $PATH | tr ':' '\n' | grep .local/bin`）。
然后：

**Claude Code：**

```bash
claude mcp add --scope user --transport stdio context-sniper -- context-sniper-mcp
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.context_sniper]
command = "context-sniper-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 120
```

**DeepSeek Harness**（`$DSH_HOME/cordis.patch.yml`）：

```yaml
- id: context-sniper
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: context-sniper
    transport: stdio
    command: context-sniper-mcp
    args: []
```

重新构建项目（`npm run build`）后无需改动任何配置——启动脚本每次都会先
`cd` 进项目目录，再运行当前的 `build/index.js`，所以两边的客户端配置都
不需要再变动。
