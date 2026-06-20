# 代码规范

> 最后更新: 2026-06-17 · 基于 v0.4.0 重构后的代码库

---

## 1. 运行时与工具链

| 规则 | 说明 |
|------|------|
| **Bun 管理一切** | 编译、测试、运行、依赖管理均使用 `bun`。禁止 `npm`/`node`/`tsc` 直接调用 |
| **bun:sqlite** | 所有数据库操作统一使用 `bun:sqlite`，禁止 `better-sqlite3` 等 Node.js 原生模块 |
| **运行方式** | 使用 `bun run <file>` 或 `bun <file>`，禁止 `node <file>` |
| **类型检查** | `bun run --bun tsc --noEmit` |

## 2. 项目结构

```
src/
├── cli.ts                  # CLI 入口（REPL + 单次模式）
├── server.ts               # HTTP 服务入口（Bun.serve）
├── sse-handler.ts           # SSE 流式响应
├── core/
│   ├── agent.ts             # GaokaoAgent — 薄门面，组合各模块
│   ├── chat-loop.ts         # ChatLoop — 多轮对话循环（LLM ↔ Tool）
│   ├── tool-executor.ts     # ToolExecutor — 工具查找与执行
│   ├── message-builder.ts   # buildMessages() — 构建 LLM 消息列表（纯函数）
│   ├── llm-client.ts        # LLMClient — LLM API 调用封装（chat + chatStream + generateTitle）
│   ├── config.ts            # 共享配置（env var 读取）
│   ├── create-agent.ts      # Agent 工厂函数（CLI/Server 共用）
│   ├── types.ts             # 共享类型（ProgressEvent, LLMMessage, ToolCall 等）
│   ├── db.ts                # SQLite 单例 + schema 初始化
│   ├── repo/
│   │   ├── session-repo.ts  # SessionRepo — 会话 CRUD
│   │   └── message-repo.ts  # MessageRepo — 消息存储（事务原子写入）
│   ├── embedding.ts         # EmbeddingService
│   └── qdrant.ts            # QdrantClient
├── tools/
│   ├── types.ts             # Tool 接口 + ToolDefinition
│   ├── search-knowledge.ts  # KnowledgeSearchTool
│   ├── search-wiki.ts       # SearchWikiTool
│   ├── web-search.ts        # WebSearchTool（包装 search-web provider）
│   └── search-web/          # Web 搜索 provider（Brave/Tavily）
├── prompts/
│   └── system.ts            # SYSTEM_PROMPT
└── web/
    └── src/
        ├── App.tsx           # 根组件（ChatProvider 包裹）
        ├── ChatContext.tsx   # 全局状态（useReducer FSM）
        ├── ChatArea.tsx      # 对话区（纯渲染 + SSE 消费）
        ├── SessionList.tsx   # 会话列表
        ├── ToolCallCard.tsx  # 工具调用卡片
        └── main.tsx          # 入口
```

## 3. 架构原则

### 3.1 单文件单职责

每个模块只做一件事：
- `agent.ts` — 薄门面，组合 LLMClient/ChatLoop/Repo，不包含业务逻辑
- `chat-loop.ts` — 只负责 LLM ↔ Tool 的多轮循环
- `message-builder.ts` — 纯函数，根据输入构建消息数组
- `llm-client.ts` — 只负责 HTTP 调用 LLM API

### 3.2 Repository 模式

所有数据访问通过 `*Repo` 类：
- 每个 Repo 方法独立调用 `getDb()`（bun:sqlite 单例保证连接复用）
- `MessageRepo.saveExchange()` 使用显式 `BEGIN/COMMIT/ROLLBACK` 事务保证原子写入
- `SessionRepo.create()` 通过 `this.get()` 读回 DB 实际值，不手工构造返回对象

### 3.3 Tool 接口

所有工具实现统一的 `Tool` 接口（`src/tools/types.ts`）：

```ts
interface Tool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}
```

- `definition` 声明工具的 name/description/parameters（传给 LLM）
- `execute(args)` 执行工具，返回结果字符串
- 工具通过 `AgentConfig.tools: Tool[]` 注入，不硬编码

### 3.4 前端 FSM

使用 `useReducer` 管理全局状态（`ChatContext.tsx`）：
- **2 状态**: `idle` | `busy`（不超 3 个）
- **9 action**: SET_SESSION / NEW_SESSION / CLEAR_SESSION / SET_INPUT / SUBMIT / PROGRESS / TOKEN / ANSWER / ERROR
- 状态字段只包含真正需要的：`status`, `sessionId`, `messages`, `progress`, `streamingContent`, `input`
- 不存可推导的值（如 `error` 字符串已附加到 messages 末尾，不单开字段）
- 每个 action type 必须有对应 dispatch 调用点（不允许死代码）

### 3.5 共享优于复制

- **config**: `src/core/config.ts` 由 CLI 和 Server 共用
- **agent 工厂**: `src/core/create-agent.ts` 封装 Qdrant/Embedding/Tools 组装
- **类型**: `src/core/types.ts` 存放 `ProgressEvent`/`LLMMessage`/`ToolCall` 等共用类型

## 4. 命名规范

| 类别 | 规范 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `chat-loop.ts`, `message-builder.ts` |
| 类名 | PascalCase | `GaokaoAgent`, `ChatLoop`, `SessionRepo` |
| 函数/方法 | camelCase | `buildMessages()`, `loadHistory()`, `autoTitle()` |
| 接口 | PascalCase | `Tool`, `LLMMessage`, `ProgressEvent` |
| 常量 | UPPER_SNAKE | `SYSTEM_PROMPT`, `MEMORY_KEYS` |
| 中文标签 | 中文 | `"省份"`, `"意向专业"`（不做国际化分离） |

## 5. 错误处理

| 场景 | 策略 |
|------|------|
| **DB 写入失败** | `catch { /* 不阻塞回答 */ }` — answer 已生成，DB 错误静默 |
| **工具执行异常** | ChatLoop 内 try-catch，返回 `"工具执行错误: ..."` 给 LLM 继续推理 |
| **LLM 返回异常 JSON** | 跳过当前 event，不中止 SSE 流 |
| **SSE 客户端断开** | `AbortError` 静默处理，不 dispatch ERROR |
| **API 路径不存在** | 返回 `{ error: "not found" }` (404) |
| **API 参数缺失** | 返回 `{ error: "sessionId and prompt required" }` (400) |

## 6. 数据库

- **引擎**: bun:sqlite, WAL 模式, foreign_keys = ON
- **Schema**: `initSchema()` 用 `CREATE TABLE IF NOT EXISTS` 幂等创建
- **事务**: 消息存储使用显式 `BEGIN/COMMIT/ROLLBACK`
- **LEFT JOIN**: 过滤条件必须写在 `ON` 子句内，不能写在 `WHERE` 中（否则 LEFT JOIN 退化为 INNER JOIN）
- **时间戳**: 使用 SQLite `datetime('now')` 默认值，不在应用层构造

## 7. SSE 流式响应

- 使用 `ReadableStream<Uint8Array>` 实现
- 每事件格式: `event: <type>\ndata: <JSON>\n\n`
- 事件类型: `progress`（含 `token`/`thinking`/`tool_call`/`tool_result` 子类型） | `done` | `error`
- 前端 SSE 消费后 dispatch 到 FSM reducer（token → TOKEN，其他 progress → PROGRESS）
- AbortSignal 从 SSE handler → agent → chat-loop → llm-client 全链路透传
- **会话切换时清 activeSidRef 过滤旧进度事件**，done/error 始终派发确保 DB 写入

## 8. Git 规范

- 每次代码更改后立即 commit
- message 简洁注明改动内容
- 使用 `Co-Authored-By: Claude <noreply@anthropic.com>` 结尾
