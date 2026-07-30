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
- 扫描支持的文件类型：`.ts`、`.tsx`、`.js`、`.jsx`、`.py`、`.java`、`.go`、`.rs`、`.md`、`.json`、`.yml`、`.yaml`、`.toml`
- 创建滑动窗口块（80 行步长，120 行最大）
- 跳过噪音：`node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`、`.venv`、`target`
- 忽略锁文件（`package-lock.json`、`pnpm-lock.yaml`）、压缩包和大于 512KB 的文件
- 将索引存储为单个 JSON 文件，位于 `<repo>/.context-index/chunks.json`

### BM25 驱动的搜索
- 使用 BM25 排名算法（k1=1.5，b=0.75）进行准确的相关性评分
- 结合块内的词频和整个语料库的文档频率
- 返回前 K 个结果，包含文件路径、行范围、相关性分数和代码片段

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
├── index.ts          # MCP 服务器设置 + 工具注册
├── repo-index.ts     # 仓库扫描、分块、索引 I/O
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

安装和客户端配置请参阅 [INSTALL.md](./INSTALL.md)。

## 使用工作流程

1. **先索引**：每个仓库调用一次 `index_repo`（并在重大更改后重新调用）
2. **先搜索后阅读**：使用 `search_code` 搜索关键词、函数名或错误消息
3. **精确提取**：仅当需要比搜索提供更多上下文时使用 `read_snippet`
4. **安全运行测试**：使用 `run_test_filtered` 进行故障诊断

### 示例交互
```
# 首先，索引仓库
index_repo(root: "/path/to/your/project")

# 搜索相关代码
search_code(root: "/path/to/your/project", query: "authentication middleware")

# 需要时读取特定行
read_snippet(root: "/path/to/your/project", path: "src/auth.ts", startLine: 45, endLine: 80)

# 运行测试以验证更改
run_test_filtered(root: "/path/to/your/project", command: "npm_test")
```

## Token 效率

传统方法与 Context Sniper 对比：

| 任务 | 传统方法 | Context Sniper | 节省 |
|------|----------|----------------|------|
| 查找认证代码 | 15,000+ tokens | ~2,000 tokens | 87% |
| 调试失败测试 | 20,000+ tokens | ~3,000 tokens | 85% |
| 理解模块结构 | 10,000+ tokens | ~1,500 tokens | 85% |

## 限制

- **语言支持**：仅可搜索已索引的文件类型（参见上面支持的扩展名）
- **二进制文件**：完全跳过（包含空字节的文件）
- **大文件**：跳过大于 512KB 的文件以防止索引膨胀
- **测试命令**：仅允许 `npm test`、`pnpm test` 和 `pytest`
- **片段长度**：搜索结果每个块限制为 4000 个字符

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

本项目已配置 context-sniper-mcp。在探索或调试代码库时，优先使用它的工具而非默认的 Read/Grep，可节省 85%+ 的 token。

**工具：**
- `index_repo(root)` — 首次使用前调用一次，代码大改后重新调用
- `search_code(root, query)` — 用关键词或自然语言搜索，返回相关代码片段
- `read_snippet(root, path, startLine, endLine)` — 搜索结果不够时，精确读取指定行范围（上限 300 行）
- `run_test_filtered(root, command)` — 运行测试，仅返回失败相关输出（command: `npm_test` / `pnpm_test` / `pytest`）

**工作流：**
1. 先 `index_repo`（如果 `.context-index/` 已存在则跳过）
2. 需要找代码时用 `search_code`，不要直接 Read 整个文件
3. 搜索结果不够精确时，用 `read_snippet` 补充上下文
4. 改完代码后用 `run_test_filtered` 验证
```

## 协议

MIT