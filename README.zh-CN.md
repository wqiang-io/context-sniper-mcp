# context-sniper-mcp

[English](./README.md) | 简体中文

一个轻量的本地 MCP 服务器：把仓库索引成按行范围切分的块，检索时只返回紧凑的
"证据包"（文件 + 行号 + 分数 + 片段），而不是把整个文件塞进模型上下文。
供 Claude Code 和 Codex 共用，用来在探索或调试代码库时省 token。

没有数据库——索引就是一个 JSON 文件，写在 `<repo>/.context-index/chunks.json`。

## 工具

- **index_repo** `{ root }` —— 扫描 `root`，把每个文本文件切成约 80 行一步的
  滑动窗口（每块最多 120 行），写入 `root/.context-index/chunks.json`。没有
  扩展名白名单：`.scss`、`.html`、`.vue`、`.sh`、`Makefile` 等都能搜到。跳过
  文件的依据是：一组内置的 gitignore 语法规则（`node_modules`、`.git`、
  `dist`、`build`、`.next`、`coverage`、`.venv`、`target`、`__pycache__`、
  锁文件、`*.min.*`、source map、`.env*` 密钥、图片和压缩包）、
  `root/.csignore`（见下文）、NUL 字节二进制检测，以及 512&nbsp;KB 大小上限。
- **search_code** `{ root, query, topK?, maxChars? }` —— 加载块索引，用 BM25
  风格的打分匹配 `query`。`topK`（默认 5，上限 50）限定候选块数；`maxChars`
  （默认 6000）限定整个回复的字符数。命中会裁剪到匹配的行，重叠的合并，以
  `FILE` / `LINES` / `SCORE` + 代码块的形式返回，精确格式见下文"证据包与输出
  预算"。索引不存在时会提示先运行 `index_repo`。
- **read_snippet** `{ root, path, startLine, endLine }` —— 读取 `root` 内单个
  文件的指定行范围。每次调用最多 300 行（更长的范围会被截断并附说明）。
  `path` 会解析后与 `root` 比对，任何逃出 `root` 的路径都会被拒绝。
- **run_test_filtered** `{ root, command }` —— 在固定白名单里运行一条命令
  （`npm_test` → `npm test`，`pnpm_test` → `pnpm test`，`pytest` →
  `pytest -q`），通过 `spawn` 且 `shell: false`，不允许任意 shell 执行。捕获
  stdout/stderr，只保留匹配
  `error|failed|failure|assert|expected|received|traceback` 或测试文件路径的
  行，尾部最多 120 行。没有匹配行时退回到最后 80 行原始输出。总是报告实际
  执行的命令和退出码。

刻意没有提供 `run_shell` 或类似工具——只暴露上面这四个。

## 忽略文件（`.csignore`）

在仓库根目录放一个 `.csignore` 就能把文件排除出索引。语法同 gitignore：空行
和 `#` 注释跳过；`*` 匹配单个路径段内的任意字符，`?` 匹配一个字符，`**` 匹配
任意多段，`[abc]` 是字符类；不含 `/` 的模式匹配任意深度的文件名或目录名；含
`/` 的模式锚定到根目录（开头的 `/` 可省略）；末尾 `/` 只匹配目录；`!` 可以把
前面的规则或内置默认排除的内容重新放行，后面的规则覆盖前面的。不支持 `\`
转义和嵌套的 ignore 文件。

```
# .csignore
REVIEW.md
.claude/
docs/**/*.snap
!dist/
```

刻意不读取 `.gitignore`：版本控制的噪音和搜索的噪音不是一回事（一个把嵌套
后端仓库藏起来的 `.gitignore`，不应该把它从搜索里也藏掉）。改完 `.csignore`
要重新运行 `index_repo`，结果里会报告读到几条规则、跳过了多少文件或目录。

## 证据包与输出预算

`search_code` 从不整块返回。对前 `topK` 个候选块，只保留含查询词的行及其上下
各 2 行；同一文件里裁剪后范围重叠或相邻的候选合并成一条命中。所以返回的命中
数可能少于 `topK`，同一响应里也不会重复返回任何行区间。一条命中长这样：

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

`LINES` 是裁剪后的跨度。跨度内没展示的部分都会在代码块里标出来：

- `... (lines A-B omitted)` —— 两段命中之间被裁掉的行。
- `... (truncated at 4000 chars; use read_snippet <path> <line> <end> to expand)`
  —— 单条命中超过每条 4000 字符的上限，从 `<line>` 续读。
- `... (budget: N chars omitted; use read_snippet <path> <start> <end> to expand)`
  —— 整包的 `maxChars` 预算在这条命中里用完（按整行裁）。

只靠路径匹配上的块（例如查 `payments` 命中 `src/payments.ts`，但正文里没有
这个词）返回一行指针而不是代码，且只在该文件没有正文命中时出现：

````
[3] FILE: src/payments.ts
LINES: 1-60
SCORE: 2.1
```
(matched on path only: no query token in lines 1-60; use read_snippet src/payments.ts 1 60 to view)
```
````

整包上限由 `maxChars` 控制（默认 6000 字符，约 1.5k token）。命中按分数顺序
加入，放不下的第一条按上面的方式裁掉，其余命中在末尾列出，仍然可以取回：

```
... (budget: 3 more hits omitted: src/cli.ts 81-172, README.zh-CN.md 84-88, README.md 51-62; use read_snippet <path> <start> <end> to expand, or raise maxChars)
```

只要展示了至少一条命中，这个尾注就至少列出一条被省略的命中。想看更多就调高
`maxChars` 或收窄查询。`No matching chunks found.` 表示没有任何块含查询词：
分词器会转小写、按字母数字下划线以外的字符切分、丢弃单字符，且不拆驼峰，所以
`handleSubmit` 是一个词。

## 安装

安装和客户端配置见 [INSTALL.zh-CN.md](./INSTALL.zh-CN.md)。

## 命令行（CLI）用法

同一个可执行文件也可以直接在 shell 里当命令行工具用——传入子命令就会执行一次
并退出，而不是启动 MCP stdio 服务：

```bash
context-sniper-mcp index <root>
context-sniper-mcp search <root> <query...> [--top-k N] [--max-chars N]
context-sniper-mcp read <root> <path> <startLine> <endLine>
context-sniper-mcp test <root> <npm_test|pnpm_test|pytest> [--timeout ms]
context-sniper-mcp help
context-sniper-mcp --version
```

每个子命令与上面同名用途的工具一一对应，输出同样的人类可读格式。`test` 透传
被测命令自身的退出码（超时返回 `124`），方便在脚本里用，例如
`context-sniper-mcp test . npm_test || echo "tests failed"`。不带参数运行仍然
启动 MCP stdio 服务器。

## 推荐用法

1. 每个仓库先调用一次 **index_repo**（大改后再调一次），再做别的。
2. 修 bug 之前优先 **search_code** 而不是打开文件——先搜症状、错误信息或函数名。
3. 不要一上来读整个文件。让 `search_code` 的证据包告诉你该看哪里。
4. 测试失败时用 **run_test_filtered** 拿裁剪过的失败输出，而不是把原始测试日志
   灌进上下文。
5. 命中末尾带省略标记时照着做：标记里写明了 **read_snippet** 的精确参数
   （`<path> <start> <end>`，每次仍以 300 行为限），不必读整个文件。只有尾注
   列出的多条被省略命中你确实需要时，才调高 `maxChars`。

## 在 CLAUDE.md / AGENTS.md 中使用

把下面这段粘到项目的 `CLAUDE.md` 或 `AGENTS.md`，让 Agent 先想到 Context Sniper
再想到 `Read`。这段内容每一轮都会被加载，所以尽量短；其余细节由服务器自带的
工具描述承担。

```markdown
## Context Sniper

本仓库已接入 `context-sniper` MCP 服务器。打开文件之前先用它定位代码：一次
`search_code` 回复不超过 6000 字符（约 1.5k token），只返回命中行及上下各 2 行。

工具（`root` 一律传本仓库的绝对路径）：
- `index_repo(root)` —— `.context-index/` 不存在时运行；`git pull`、大改或修改
  `.csignore` 之后再运行一次。如果片段的行号和文件对不上，说明索引过期，重建。
- `search_code(root, query, topK?, maxChars?)` —— 关键词检索（BM25），不是语义
  检索。用代码里实际出现的标识符、错误字符串和有区分度的词来查；驼峰是一个词，
  单字符会被丢弃。先用默认参数；查询范围宽时调高 `topK`，只有尾注列出的被省略
  命中你确实需要时才调高 `maxChars`。
- `read_snippet(root, path, startLine, endLine)` —— 有界读取，最多 300 行。搜索
  结果里每个省略标记都写明了精确调用参数，照抄即可，不要读整个文件。
- `run_test_filtered(root, command)` —— `npm_test` / `pnpm_test` / `pytest`，只
  返回和失败相关的行。

工作流：
1. 用 `search_code` 定位，照着标记用 `read_snippet` 扩展。
2. 只有准备编辑某个文件或文件很短时才整读它。精确字符串、正则和上次索引之后
   新增的文件仍然用 `Grep`。
3. 改完用 `run_test_filtered` 验证，不要直接跑原始测试命令。
```

## Token 效率

2026-09-19 实测；token 按字符数 ÷ 4 粗估。"旧版"指此前整块返回的
`search_code`，"新版"为当前默认参数（`topK` 5，`maxChars` 6000）。

| 查询 | 语料 | 旧版 | 新版 |
|------|------|------|------|
| `timeout kill process group` | 本仓库（13 文件） | 14,279 字符 ≈ 3.6k token | 2,907 字符 ≈ 0.7k token |
| `index`，`topK` 50 | 本仓库 | 53,010 字符 ≈ 13k token | 5,992 字符 ≈ 1.5k token（预算封顶） |
| `__table_name__` | 一个 React + FastAPI 项目（69 文件） | 8,697 字符 | 914 字符 |
| `zustand persist sidebar` | 同上 | 14,637 字符 | 2,912 字符 |

作为参照：`grep -rn SIGKILL src/` 是 207 字符，直接 `Read` 一个 120 行的文件约
4,000 到 5,000 字符。一次搜索回复不会超过 `maxChars`，被裁掉的部分都能用标记里
给出的 `read_snippet` 参数取回。

## 设计说明

- **原子写索引** —— `index_repo` 先写到索引旁边的临时文件，再 `rename()` 到位，
  所以并发的 `search_code` 永远不会读到写了一半的文件。索引带格式版本号（当前
  为 2），版本不符的文件按不存在处理，`search_code` 会提示重新运行 `index_repo`。
- **进程内缓存** —— 加载过的索引按路径和 mtime 缓存在服务器进程里，重复搜索不
  用重新解析 JSON；文件一变缓存就失效。
- **不允许任意执行** —— `read_snippet` 把 `path` 解析后与 `root` 比对，逃出
  `root` 的一律拒绝；测试运行器用 `shell: false` 和固定白名单启动。

## 项目结构

```
context-sniper-mcp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # MCP 服务器接线 + 工具注册；分发到 cli.ts
│   ├── cli.ts          # shell 子命令（index/search/read/test），供终端直接调用
│   ├── repo-index.ts   # 扫描、分块、安全路径解析、索引 I/O
│   ├── ignore.ts       # gitignore 语法的忽略规则：内置默认 + .csignore
│   ├── search.ts       # BM25 风格打分 + 证据包格式化
│   ├── snippets.ts     # 有界、路径安全的行范围读取
│   ├── output-gate.ts  # 白名单测试运行器 + 输出过滤
│   └── tokenize.ts     # 索引和搜索共用的分词器
├── test/                 # 每个 src 模块对应的 *.test.mjs 单元测试
├── build/                # 编译输出（npm run build）
├── INSTALL.md
├── INSTALL.zh-CN.md
├── README.md
└── README.zh-CN.md
```

## 协议

MIT
