# Context Sniper MCP

一个轻量级的本地 MCP 服务器，用于索引代码仓库并返回紧凑的"证据包"，而不是将整个文件转储到模型上下文中。专为 Claude Code 和 Codex 设计，可在探索或调试代码库时显著减少 token 使用量。

## 目的

处理大型代码库时，AI 模型通常需要读取整个文件来理解上下文，导致 token 消耗过多。Context Sniper 通过以下方式解决此问题：

1. **索引** 仓库文件为可管理的块（每个约 80 行）
2. **搜索** 使用 BM25 排名算法找到最相关的代码段
3. **返回** 仅所需的特定行，而非整个文件

这种方法可以将代码探索任务的 token 使用量减少 90% 或更多。

## 核心功能

### 智能文件索引
- 索引所有文本文件（按内容判断：含 NUL 字节的视为二进制跳过），不限制扩展名，`.scss`、`.html`、`.vue`、`.sh`、`Makefile` 都能搜到
- 内置一组 gitignore 语法的默认忽略规则：`node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`、`.venv`、`target`、`__pycache__` 等目录，锁文件、`*.min.*`、source map，`.env*` 等密钥文件（`.env.example` 除外），图片、字体、压缩包
- 在仓库根目录放一个 `.csignore` 追加自己的规则：语法同 gitignore，支持 `*`、`**`、`?`、`[abc]`、目录后缀 `/`、`!` 取反，后面的规则覆盖前面的，也能用 `!` 放行默认忽略的内容；改完要重新 `index_repo`，结果里会报告读到几条规则、跳过了多少文件或目录
- 不读取 `.gitignore`：版本控制的忽略规则和搜索的忽略规则不是一回事
- 创建滑动窗口块（80 行步长，120 行最大）
- 跳过大于 512KB 的文件
- 将索引存储为单个 JSON 文件，位于 `<repo>/.context-index/chunks.json`

### BM25 驱动的搜索
- 使用 BM25 排名算法（k1=1.5，b=0.75）进行准确的相关性评分
- 结合块内的词频和整个语料库的文档频率
- `topK`（默认 5，上限 50）限定参与输出的候选块数，`maxChars`（默认 6000）限定整包字符数
- 每条命中只保留含查询词的行及上下文，同文件重叠的命中合并，格式见下一节

### 证据包与输出预算
`search_code` 不会整块返回。对前 `topK` 个候选块，只保留含查询词的行及其上下各 2 行；同一文件里裁剪后范围重叠或相邻的候选合并成一条命中，所以返回的命中数可能少于 `topK`，同一响应里也不会重复返回任何行区间。每条命中是 `[n] FILE / LINES / SCORE` 加一个代码块，`LINES` 是裁剪后的跨度，跨度内没展示的部分都在代码块里标出来：

- `... (lines A-B omitted)` —— 两段命中之间被裁掉的行
- `... (truncated at 4000 chars; use read_snippet <path> <line> <end> to expand)` —— 单条命中超过 4000 字符上限，从 `<line>` 续读
- `... (budget: N chars omitted; use read_snippet <path> <start> <end> to expand)` —— 整包预算在这条命中里用完（按整行裁）

只靠路径匹配上的块（例如查 `payments` 命中 `src/payments.ts`，但正文里没有这个词）返回一行指针而不是代码：`(matched on path only: no query token in lines 1-60; use read_snippet src/payments.ts 1 60 to view)`，且只在该文件没有正文命中时出现。

整包上限由 `maxChars` 控制（默认 6000 字符，约 1.5k token）：按分数顺序加入命中，放不下的第一条按整行裁掉并打上述标记，其余命中在末尾列出路径和行号，例如 `... (budget: 3 more hits omitted: src/cli.ts 81-172, HUMAN.md 84-88, README.md 51-62; use read_snippet <path> <start> <end> to expand, or raise maxChars)`。只要展示了至少一条命中，尾注就一定列出被省略命中的路径。`No matching chunks found.` 表示没有任何块含查询词：分词器会转小写、按字母数字下划线以外的字符切分、丢弃单字符，且不拆驼峰（`handleSubmit` 是一个词）。

### 有界代码读取
- `read_snippet` 工具用于精确的行范围提取
- 每次调用硬性限制为 300 行，防止上下文溢出
- 路径验证确保文件保留在仓库边界内

### 安全测试执行
- 通过固定白名单运行测试：`npm test`、`pnpm test`、`pytest`
- 不允许任意 shell 执行
- 过滤输出以仅显示错误/失败相关行
- 5 分钟超时并清理进程组

## 架构

### 文件结构
```
src/
├── index.ts          # MCP 服务器设置 + 工具注册；根据启动参数分发到 cli.ts
├── cli.ts            # 命令行子命令（index/search/read/test），供终端直接调用
├── repo-index.ts     # 仓库扫描、分块、索引 I/O
├── ignore.ts         # gitignore 语法的忽略规则：内置默认 + .csignore
├── search.ts         # BM25 评分 + 证据包格式化
├── snippets.ts       # 有界行范围读取与路径验证
├── output-gate.ts    # 安全测试运行器与输出过滤
└── tokenize.ts       # 用于索引和查询的共享分词器
```

### 关键设计决策

**基于块的架构**
- 文件被分割为重叠窗口（80 行步长，120 行最大）
- 每个块存储预计算的词频，用于快速 BM25 评分
- 跟踪平均块长度，用于 BM25 的长度归一化

**原子索引写入**
- 索引更新使用临时文件 + 重命名模式
- 确保并发搜索永远不会看到半写入的索引
- 索引版本控制（当前为 v2）处理格式迁移

**进程生命周期缓存**
- 加载的索引按文件路径 + 修改时间缓存
- 避免在重复搜索时重新解析 JSON
- 当索引文件被修改时缓存失效

**安全设计**
- 路径验证防止目录遍历攻击
- 测试运行器使用 `shell: false` 和固定命令白名单
- 不可能执行任意命令
- 索引默认排除 `.env*`、`*.pem`、`*.key`、`id_rsa*` 等密钥文件，`search_code` 不会把密钥读回来

安装和客户端配置请参阅 [INSTALL.zh-CN.md](./INSTALL.zh-CN.md)（含 Claude Code、Codex、DeepSeek Harness）。

## 命令行（CLI）用法

同一个可执行文件也可以直接在 shell 里当命令行工具用 —— 传入子命令就会执行一次并退出，而不是启动 MCP stdio 服务：

```bash
context-sniper-mcp index <root>
context-sniper-mcp search <root> <query...> [--top-k N] [--max-chars N]
context-sniper-mcp read <root> <path> <startLine> <endLine>
context-sniper-mcp test <root> <npm_test|pnpm_test|pytest> [--timeout ms]
context-sniper-mcp help
context-sniper-mcp --version
```

`test` 子命令会透传被测命令自身的退出码（超时则返回 124），方便在脚本 / CI 里判断成败。不带任何参数运行时行为不变，仍然启动 MCP stdio 服务器——`src/index.ts` 只是在启动时检查第一个参数是否命中已知子命令，命中才转发给 `src/cli.ts`，否则原样走 MCP 逻辑，不影响现有的 MCP 客户端接入方式。

## 使用工作流程

1. **先索引**：每个仓库调用一次 `index_repo`（并在重大更改后重新调用）
2. **先搜索后阅读**：使用 `search_code` 搜索关键词、函数名或错误消息
3. **精确提取**：命中里的省略标记直接给出 `read_snippet` 的路径和行号，照着读；只有尾注列出多条你需要的命中时才调高 `maxChars`
4. **安全运行测试**：使用 `run_test_filtered` 进行故障诊断

### 示例交互
```
# 首先，索引仓库
index_repo(root: "/path/to/your/project")

# 搜索相关代码（整包默认不超过 6000 字符，可用 topK / maxChars 调整）
search_code(root: "/path/to/your/project", query: "authentication middleware")
search_code(root: "/path/to/your/project", query: "authentication middleware", topK: 20, maxChars: 3000)

# 需要时读取特定行
read_snippet(root: "/path/to/your/project", path: "src/auth.ts", startLine: 45, endLine: 80)

# 运行测试以验证更改
run_test_filtered(root: "/path/to/your/project", command: "npm_test")
```

## Token 效率

以下为 2026-09-19 的实测数字（字符数 ÷ 4 粗估 token；"旧版"指此前整窗口返回的 `search_code`，"新版"为默认 topK 5、maxChars 6000）：

| 查询 | 语料 | 旧版 | 新版 |
|------|------|------|------|
| `timeout kill process group` | 本仓库（13 文件） | 14,279 字符 ≈ 3.6k token | 2,907 字符 ≈ 0.7k token |
| `index`，topK=50 | 本仓库 | 53,010 字符 ≈ 13k token | 5,992 字符 ≈ 1.5k token（预算封顶） |
| `__table_name__` | 一个 React + FastAPI 项目（69 文件） | 8,697 字符 | 914 字符 |
| `zustand persist sidebar` | 同上 | 14,637 字符 | 2,912 字符 |

作为参照：`grep -rn SIGKILL src/` 是 207 字符，直接 Read 一个 120 行的文件约 4,000 到 5,000 字符。新版一次搜索的总量不会超过 `maxChars`，被裁掉的部分都能用标记里给出的 `read_snippet` 参数按需取回。

## 限制

- **覆盖范围**：只有索引时存在且未被忽略规则排除的文本文件可搜索；改了 `.csignore` 或新增文件后要重新索引
- **二进制文件**：完全跳过（包含空字节的文件）
- **大文件**：跳过大于 512KB 的文件以防止索引膨胀
- **测试命令**：仅允许 `npm test`、`pnpm test` 和 `pytest`
- **输出上限**：每条命中最多 4000 字符，整包默认最多 6000 字符（`maxChars` 可调）；被裁掉的部分都带 `read_snippet` 参数可以取回

## 开发

### 构建
```bash
npm run build     # 一次性构建
npm run dev       # 开发模式的监视模式
```

### 测试
```bash
npm test          # 通过 Node.js 测试运行器运行所有测试
```

### 项目结构
- `src/` - TypeScript 源代码
- `build/` - 编译后的 JavaScript 输出
- `test/` - 测试文件（`.test.mjs`）
- `.context-index/` - 生成的索引文件（已 gitignore）

## 在 CLAUDE.md / AGENTS.md 中使用

在项目的 `CLAUDE.md` 或 `AGENTS.md` 中加入以下内容，让 AI Agent 自动使用 Context Sniper：

```markdown
## Context Sniper

本项目已配置 context-sniper-mcp。在探索或调试代码库时，优先使用它的工具而非默认的 Read/Grep：一次搜索默认不超过 6000 字符（约 1.5k token），只返回命中行附近的代码。

**工具：**
- `index_repo(root)` — 首次使用前调用一次，代码大改后重新调用
- `search_code(root, query, topK?, maxChars?)` — 用关键词搜索，返回命中行 ±2 行的片段；被省略的部分都带 `read_snippet` 参数
- `read_snippet(root, path, startLine, endLine)` — 搜索结果不够时，精确读取指定行范围（上限 300 行）
- `run_test_filtered(root, command)` — 运行测试，仅返回失败相关输出（command: `npm_test` / `pnpm_test` / `pytest`）

**工作流：**
1. 先 `index_repo`（如果 `.context-index/` 已存在则跳过）
2. 需要找代码时用 `search_code`，不要直接 Read 整个文件
3. 需要更多上下文时，照着结果里省略标记给出的路径和行号用 `read_snippet` 读
4. 改完代码后用 `run_test_filtered` 验证
```

## 协议

MIT