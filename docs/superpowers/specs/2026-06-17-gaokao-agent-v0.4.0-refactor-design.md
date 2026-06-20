# Gaokao Agent v0.4.0 — 架构重构设计

> 日期: 2026-06-17 | 状态: 设计中

---

## 一、目标

将 v0.3.1 快速迭代中积累的技术债务一次性清偿：前端状态机化、API RESTful 化、工具接口统一、数据库 Repository 化、Agent 核心解耦。

---

## 二、架构全景

```
┌──────────────────────────────────────────────────────────┐
│  前端 (React 19 + Vite 6)                                │
│  ┌─────────┐ ┌──────────┐ ┌──────────────┐              │
│  │ ChatFSM │ │ Session  │ │ MemoryPanel  │              │
│  │ reducer │ │ List     │ │ (Abort安全)  │              │
│  └────┬────┘ └────┬─────┘ └──────┬───────┘              │
│       └───────────┴──────────────┘                       │
│                      │ SSE fetch + REST fetch            │
└──────────────────────┼──────────────────────────────────┘
                       │
┌──────────────────────┼──────────────────────────────────┐
│  后端 (Bun.serve :3211)                                  │
│                      │                                    │
│  ┌───────────────────┴──────────────────┐                │
│  │ Router (RESTful)                     │                │
│  │ POST /api/chat                       │                │
│  │ CRUD /api/sessions[/:id]             │                │
│  │ CRUD /api/sessions/:id/memories[/:k] │                │
│  └───────┬──────────────┬────────────────               │
│          │              │                                 │
│  ┌───────┴────┐ ┌──────┴──────────┐                     │
│  │ SSEHandler │ │ MemoryExtractor │                     │
│  │ (流管理)   │ │ (fire+forget)   │                     │
│  └───────┬────┘ └─────────────────┘                     │
│          │                                                │
│  ┌───────┴─────────────────────────────────┐            │
│  │ GaokaoAgent                              │            │
│  │ ┌──────────┐ ┌──────────┐ ┌───────────┐ │            │
│  │ │ChatLoop  │ │ToolExec  │ │MsgBuilder │ │            │
│  │ │(ReAct)   │ │(Tool接口)│ │(prompt+史)│ │            │
│  │ └──────────┘ └────┬─────┘ └───────────┘ │            │
│  └───────────────────┼─────────────────────┘            │
│                      │                                    │
│  ┌───────────────────┼─────────────────────┐            │
│  │ Tools (统一 Tool 接口)                   │            │
│  │ ┌──────────┐ ┌──────────┐ ┌───────────┐ │            │
│  │ │Knowledge │ │WebSearch │ │WikiRead   │ │            │
│  │ │Tool      │ │Tool      │ │Tool       │ │            │
│  │ └──────────┘ └──────────┘ └───────────┘ │            │
│  └─────────────────────────────────────────┘            │
│                      │                                    │
│  ┌───────────────────┼─────────────────────┐            │
│  │ Repositories                              │            │
│  │ ┌──────────┐ ┌──────────┐ ┌───────────┐ │            │
│  │ │Session   │ │Message   │ │Memory     │ │            │
│  │ │Repo      │ │Repo      │ │Repo       │ │            │
│  │ └──────────┘ └──────────┘ └───────────┘ │            │
│  │              SQLite (bun:sqlite)         │            │
│  └─────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────┘
```

---

## 三、前端 — ChatFSM 状态机

### 状态定义

```
States:
  idle       — 无会话或刚加载，显示欢迎页
  composing  — 用户正在输入
  loading    — 等待首个 SSE 事件
  streaming  — SSE 事件持续到达（thinking/tool_call/tool_result）
  done       — 最终回答已渲染，输入框解锁
  error      — 请求失败，显示错误信息

Transitions:
  idle         → composing   : 选中会话或开始输入
  composing    → loading     : 提交消息
  loading      → streaming   : 收到第一个 progress 事件
  loading      → done        : 无需工具直接返回（progress 事件 type=done）
  loading      → error       : fetch 失败
  streaming    → streaming   : 更多 progress 事件
  streaming    → done        : 收到 event:done
  streaming    → error       : 收到 event:error
  done         → composing   : 用户开始输入新消息
  error        → composing   : 用户重试
```

### reducer 结构

```ts
interface ChatState {
  status: 'idle' | 'composing' | 'loading' | 'streaming' | 'done' | 'error';
  sessionId: string | null;
  messages: Message[];
  progress: ToolEvent[];
  error: string | null;
  input: string;
}

type ChatAction =
  | { type: 'SET_SESSION'; id: string }
  | { type: 'SET_INPUT'; value: string }
  | { type: 'SUBMIT'; prompt: string }        // composing → loading
  | { type: 'PROGRESS'; event: ToolEvent }    // loading → streaming, streaming → streaming
  | { type: 'ANSWER'; content: string }       // streaming → done, loading → done
  | { type: 'ERROR'; message: string }        // → error
  | { type: 'RETRY' }                         // error → composing
  | { type: 'CLEAR_SESSION' }                 // → idle
```

### 组件拆分

- `App.tsx` — 顶层布局，持有 `useReducer(chatReducer, ...)`，通过 Context 下发
- `ChatContext.tsx` — `createContext<ChatContextType>`，暴露 state + dispatch
- `ChatArea.tsx` — 纯渲染：消息列表 + 进度卡片 + 输入框，从 Context 取数据
- `MemoryPanel.tsx` — 独立 fetch 自己的数据，不受 FSM 影响
- `SessionList.tsx` — 独立管理会话列表

---

## 四、API — RESTful 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST /api/chat` | SSE 流式对话 `{ sessionId, prompt }` | 不变 |
| `GET /api/sessions` | 会话列表 | 不变 |
| `POST /api/sessions` | 创建会话 | 不变 |
| `GET /api/sessions/:id` | 获取会话 + 消息 | 不变 |
| `DELETE /api/sessions/:id` | 删除会话 | 不变 |
| `GET /api/sessions/:id/memories` | 获取会话记忆 | 路径调整 |
| `DELETE /api/sessions/:id/memories/:key` | 删除记忆 | 路径调整 |

路径从 `/api/memories/:id` 调整为 `/api/sessions/:id/memories`，资源嵌套语义更清晰。

---

## 五、工具 — 统一 Tool 接口

```ts
interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface Tool {
  /** OpenAI function calling 定义 */
  readonly definition: ToolDefinition;
  /** 执行工具，返回文本结果 */
  execute(args: Record<string, unknown>): Promise<string>;
}
```

三个工具实现：

| 类 | 职责 |
|---|------|
| `KnowledgeSearchTool` | 封装 `QdrantClient` + `EmbeddingService`，execute 内完成 embed → search → readFullPage |
| `WebSearchTool` | 封装 `SearchProvider`，execute 内调 `provider.search()` |
| `WikiReadTool` | 封装文件系统 + name index，execute 内完成路径解析 → 读取 → wiki 链接替换 |

Agent 不再直接依赖具体工具类，只依赖 `Tool[]`。

---

## 六、数据库 — Repository 模式

```ts
class SessionRepo {
  create(title?: string): Session;
  list(limit?: number): Session[];
  get(id: string): Session | null;
  delete(id: string): void;
  touch(id: string): void;  // 更新 updated_at
}

class MessageRepo {
  saveExchange(sessionId: string, userPrompt: string, assistantContent: string): void;
  loadHistory(sessionId: string): MessageRow[];
}

class MemoryRepo {
  get(sessionId: string, key: string): string | null;
  set(sessionId: string, key: string, value: string, category?: string): void;
  list(sessionId: string): MemoryEntry[];
  delete(sessionId: string, key: string): void;
  extractFromTurn(sessionId: string, prompt: string, answer: string, llm: LightLLM): Promise<void>;
}
```

三个 Repo 共享同一个 `bun:sqlite` Database 实例（通过 `getDb()`），各自只关心自己的表。

---

## 七、Agent — 核心解耦

### ChatLoop（纯 ReAct 循环）

```ts
class ChatLoop {
  constructor(
    private llm: LLMClient,
    private tools: Tool[],
    private maxRounds: number,
  ) {}

  async run(messages: LLMMessage[], onProgress?: ProgressCallback): Promise<string>;
}
```

- 不依赖 Session/Memory/DB
- 不依赖具体工具实现
- progress 通过回调参数传入（非 this.onProgress）

### ToolExecutor

```ts
class ToolExecutor {
  constructor(private tools: Tool[]) {}

  async execute(name: string, args: Record<string, unknown>): Promise<string>;
  getDefinition(name: string): ToolDefinition | undefined;
  getAllDefinitions(): ToolDefinition[];
}
```

### MessageBuilder

纯函数，组装 system prompt + memory + history + user prompt：

```ts
function buildMessages(sessionId: string, userPrompt: string): LLMMessage[];
```

### GaokaoAgent（门面）

薄封装，组合 ChatLoop + MessageBuilder + Repos：

```ts
class GaokaoAgent {
  async chat(userPrompt: string, sessionId: string, onProgress?: ProgressCallback): Promise<string>;
  async lightCall(system: string, user: string): Promise<string>;
}
```

---

## 八、文件结构

```
src/
├── cli.ts
├── server.ts                    ← 精简，只做路由 + SSE
├── core/
│   ├── db.ts                    ← getDb() + 建表
│   ├── embedding.ts             ← 不变
│   ├── qdrant.ts                ← 不变
│   ├── agent.ts                 ← 门面，薄封装
│   ├── chat-loop.ts             ← ReAct 循环
│   ├── tool-executor.ts         ← Tool 调度
│   ├── message-builder.ts       ← 消息组装
│   ├── llm-client.ts            ← LLM API 调用（从 agent.ts 拆出）
│   ├── types.ts                 ← 共享类型（ProgressEvent 等）
│   └── repo/
│       ├── session-repo.ts
│       ├── message-repo.ts
│       └── memory-repo.ts
├── tools/
│   ├── types.ts                 ← Tool 接口 + ToolDefinition
│   ├── knowledge-search.ts      ← implements Tool
│   ├── web-search.ts            ← implements Tool
│   ├── wiki-read.ts             ← implements Tool（含 name index）
│   ├── wiki-resolve.ts          ← 不变
│   └── search-web/              ← 不变（tavily/brave）
├── prompts/
│   └── system.ts
├── sse-handler.ts               ← SSE 流管理（从 server.ts 拆出）
└── web/
    └── src/
        ├── App.tsx
        ├── ChatContext.tsx       ← Context + reducer
        ├── ChatArea.tsx
        ├── SessionList.tsx
        ├── MemoryPanel.tsx
        ├── ToolCallCard.tsx
        └── main.tsx
```

---

## 九、不变项

- 构建/运行：Bun + TypeScript strict
- 数据库：`bun:sqlite`
- LLM/Embedding：DeepSeek / LM Studio
- Qdrant：6 Collection, 10357 向量
- 知识库：wiki/ 1725 文件
- 系统提示词：张雪峰风格
- 前端视觉：Anthropic 极简

---

## 十、不在此次范围

- 上下文压缩
- Tavily 换 Brave
- 前端 streaming text（逐字）
- 自动化测试
