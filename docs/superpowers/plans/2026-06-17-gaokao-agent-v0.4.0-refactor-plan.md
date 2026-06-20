# Gaokao Agent v0.4.0 架构重构 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 v0.3.1 代码重构为 v0.4.0 架构——前端 FSM 状态机、RESTful API、统一 Tool 接口、Repository 模式、Agent 核心解耦

**Architecture:** 自底向上六阶段重构。先建基础设施（类型/接口/Repository），再重构工具层，然后解耦 Agent，接着整理服务层，最后重写前端状态管理。每一阶段结束时项目可编译可运行。

**Tech Stack:** Bun + TypeScript strict + React 19 + Vite 6 + bun:sqlite + Qdrant

**Spec:** `docs/superpowers/specs/2026-06-17-gaokao-agent-v0.4.0-refactor-design.md`

---

## 文件变更总览

```
新建 (12):
  src/core/types.ts
  src/core/llm-client.ts
  src/core/chat-loop.ts
  src/core/tool-executor.ts
  src/core/message-builder.ts
  src/core/repo/session-repo.ts
  src/core/repo/message-repo.ts
  src/core/repo/memory-repo.ts
  src/tools/types.ts
  src/sse-handler.ts
  src/web/src/ChatContext.tsx

修改 (8):
  src/server.ts
  src/core/agent.ts
  src/tools/search-knowledge.ts
  src/tools/search-wiki.ts
  src/core/db.ts
  src/web/src/App.tsx
  src/web/src/ChatArea.tsx
  src/cli.ts

删除 (2):
  src/core/session.ts      → repo/session-repo.ts + repo/message-repo.ts
  src/core/memory.ts       → repo/memory-repo.ts

不动 (15):
  src/core/embedding.ts, src/core/qdrant.ts, src/tools/wiki-resolve.ts
  src/tools/search-web/*, src/prompts/system.ts, src/web/src/SessionList.tsx
  src/web/src/MemoryPanel.tsx, src/web/src/ToolCallCard.tsx, src/web/src/main.tsx
  src/web/src/styles.css, src/web/vite.config.ts, src/web/index.html
```

---

## Phase 1: 基础设施（类型 + Repository）

### Task 1: 共享类型定义

**Files:**
- Create: `src/core/types.ts`

- [ ] **Step 1: 创建共享类型文件**

```ts
// src/core/types.ts
/** SSE 进度事件（CLI/服务端/前端共用） */
export interface ProgressEvent {
  type: "thinking" | "tool_call" | "tool_result" | "done";
  message: string;
  tool?: { name: string; args: Record<string, unknown> };
  result?: { preview: string; fullLength: number };
  ms?: number;
}

/** LLM 消息格式 */
export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/** LLM 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** LLM 调用结果 */
export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

/** 进度回调 */
export type ProgressCallback = (event: ProgressEvent) => void;
```

- [ ] **Step 2: 更新 agent.ts 的 import，从 types.ts 引入类型**

```ts
// 将 agent.ts 顶部的 ProgressEvent/ToolCall/LLMMessage 接口定义替换为 import
import type { ProgressEvent, ProgressCallback, ToolCall, LLMMessage, LLMResponse } from "./types";
```

- [ ] **Step 3: 类型检查**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add src/core/types.ts src/core/agent.ts
git commit -m "refactor: 提取共享类型到 core/types.ts"
```

### Task 2: Repository 层 — SessionRepo + MessageRepo + MemoryRepo

**Files:**
- Create: `src/core/repo/session-repo.ts`
- Create: `src/core/repo/message-repo.ts`
- Create: `src/core/repo/memory-repo.ts`
- Modify: `src/core/db.ts`

- [ ] **Step 1: 更新 db.ts，确保 WAL 模式 + 建表逻辑独立**

```ts
// src/core/db.ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  mkdirSync("data", { recursive: true });
  _db = new Database(join("data", "agent.db"));
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  return _db;
}

/** 首次启动建表，幂等 */
export function initSchema() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT 'global',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'fact',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(session_id, key)
    );
  `);
}
```

- [ ] **Step 2: 创建 SessionRepo**

```ts
// src/core/repo/session-repo.ts
import { getDb } from "../db";

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export class SessionRepo {
  create(title = ""): Session {
    const now = new Date();
    const ts =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
      `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    const id = `${ts}-${crypto.randomUUID().slice(0, 4)}`;
    getDb()
      .prepare("INSERT INTO sessions (id, title) VALUES (?, ?)")
      .run(id, title);
    return { id, title, created_at: "", updated_at: "", message_count: 0 };
  }

  list(limit = 20): Session[] {
    return getDb()
      .prepare(
        `SELECT s.*, COUNT(m.id) as message_count
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE m.role IN ('user', 'assistant')
         GROUP BY s.id
         ORDER BY s.updated_at DESC
         LIMIT ?`
      )
      .all(limit) as Session[];
  }

  get(id: string): Session | null {
    return (getDb()
      .prepare(
        `SELECT s.*, COUNT(m.id) as message_count
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id
         WHERE m.role IN ('user', 'assistant') AND s.id = ?
         GROUP BY s.id`
      )
      .get(id) as Session) || null;
  }

  delete(id: string): void {
    getDb().prepare("DELETE FROM messages WHERE session_id = ?").run(id);
    getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  touch(id: string): void {
    getDb()
      .prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?")
      .run(id);
  }

  autoTitle(sessionId: string): void {
    const row = getDb()
      .prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1")
      .get(sessionId) as { content: string } | undefined;
    if (row) {
      getDb()
        .prepare("UPDATE sessions SET title = ? WHERE id = ? AND title = ''")
        .run(row.content.slice(0, 60), sessionId);
    }
  }
}
```

- [ ] **Step 3: 创建 MessageRepo**

```ts
// src/core/repo/message-repo.ts
import { getDb } from "../db";

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

export class MessageRepo {
  /** 事务内原子写入一对 user+assistant 消息 */
  saveExchange(sessionId: string, userPrompt: string, assistantContent: string): void {
    const db = getDb();
    try {
      db.exec("BEGIN");
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run(sessionId, "user", userPrompt);
      db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
        .run(sessionId, "assistant", assistantContent);
      db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?")
        .run(sessionId);
      db.exec("COMMIT");
    } catch {
      db.exec("ROLLBACK");
      throw;
    }
  }

  loadHistory(sessionId: string): MessageRow[] {
    return getDb()
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as MessageRow[];
  }
}
```

- [ ] **Step 4: 创建 MemoryRepo**

```ts
// src/core/repo/memory-repo.ts
import { getDb } from "../db";

export interface MemoryEntry {
  key: string;
  value: string;
  category: string;
  updated_at: string;
}

export class MemoryRepo {
  set(sessionId: string, key: string, value: string, category = "fact"): void {
    getDb()
      .prepare(
        `INSERT INTO memories (session_id, key, value, category, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(session_id, key) DO UPDATE SET value=excluded.value, category=excluded.category, updated_at=datetime('now')`
      )
      .run(sessionId, key, value, category);
  }

  list(sessionId: string): MemoryEntry[] {
    return getDb()
      .prepare(
        "SELECT key, value, category, updated_at FROM memories WHERE session_id = ? ORDER BY updated_at DESC"
      )
      .all(sessionId) as MemoryEntry[];
  }

  delete(sessionId: string, key: string): void {
    getDb()
      .prepare("DELETE FROM memories WHERE session_id = ? AND key = ?")
      .run(sessionId, key);
  }

  /** LLM 驱动的自动记忆提取 */
  async extractFromTurn(
    sessionId: string,
    userPrompt: string,
    answer: string,
    lightCall: (system: string, user: string) => Promise<string>,
  ): Promise<void> {
    const existing = this.list(sessionId);
    const existingJson = JSON.stringify(existing.map((m) => ({ key: m.key, value: m.value })));

    const system = `你是一个用户信息提取器。从对话中提取用户的高考相关信息。
已有信息：${existingJson}
请输出 JSON 格式：{"memories": [{"key": "...", "value": "..."}]}
可用的 key：user_province, user_score, user_rank, user_subject, user_major_interest, user_school_interest, user_city_preference, user_budget_constraint`;

    const user = `用户提问：${userPrompt}\n\nAI回答：${answer.slice(0, 2000)}`;

    try {
      const raw = await lightCall(system, user);
      const json = JSON.parse(raw.replace(/```json\s*|\s*```/g, "").trim());
      const memories: Array<{ key: string; value: string }> = json.memories || [];
      for (const mem of memories) {
        if (mem.key && mem.value) {
          this.set(sessionId, mem.key, mem.value, "llm_extracted");
        }
      }
    } catch { /* 静默 */ }
  }
}
```

- [ ] **Step 5: 类型检查**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/core/db.ts src/core/repo/
git commit -m "refactor: Repository层 — SessionRepo/MessageRepo/MemoryRepo，事务原子写入"
```

---

## Phase 2: 工具层 — 统一 Tool 接口

### Task 3: Tool 接口 + 三个工具改造

**Files:**
- Create: `src/tools/types.ts`
- Modify: `src/tools/search-knowledge.ts`
- Modify: `src/tools/search-wiki.ts`
- Create: `src/tools/web-search.ts`

- [ ] **Step 1: 创建 Tool 接口**

```ts
// src/tools/types.ts
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Tool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>): Promise<string>;
}
```

- [ ] **Step 2: 改造 KnowledgeSearchTool 实现 Tool 接口**

```ts
// src/tools/search-knowledge.ts
import { QdrantClient, type KnowledgeHit } from "../core/qdrant";
import { EmbeddingService } from "../core/embedding";
import type { Tool, ToolDefinition } from "./types";

const COLLECTION_MAP: Record<string, string> = {
  schools: "gaokao_schools",
  majors: "gaokao_majors",
  policies_rules: "gaokao_policies_rules",
  province_data: "gaokao_province_data",
  style_cases: "gaokao_style_cases",
  score_rules: "gaokao_score_rules",
};
const ALL_COLLECTIONS = Object.values(COLLECTION_MAP);

export class KnowledgeSearchTool implements Tool {
  constructor(
    private qdrant: QdrantClient,
    private embed: EmbeddingService,
  ) {}

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "在高考知识库中语义检索。包含院校介绍、专业分析、政策规则、填报案例。返回完整文档内容。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "自然语言搜索查询" },
          topK: { type: "number", description: "返回结果数，默认3" },
          collections: {
            type: "array",
            items: {
              type: "string",
              enum: ["schools", "majors", "policies_rules", "province_data", "style_cases", "score_rules"],
            },
            description: "指定检索的知识库分类。不确定时全选或不传。",
          },
        },
        required: ["query"],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query || "");
    const topK = Number(args.topK) || 3;
    const collections = args.collections as string[] | undefined;

    const vector = await this.embed.embed(query);
    const targetCollections = collections?.length
      ? collections.map((k) => COLLECTION_MAP[k]).filter(Boolean)
      : ALL_COLLECTIONS;

    const results = await Promise.all(
      targetCollections.map((col) => this.qdrant.searchWithFullPage(col, vector, topK)),
    );

    const seen = new Set<string>();
    const hits = results
      .flat()
      .sort((a, b) => b.score - a.score)
      .filter((hit) => {
        if (seen.has(hit.sourceFile)) return false;
        seen.add(hit.sourceFile);
        return true;
      })
      .slice(0, topK * 2);

    if (hits.length === 0) return "知识库中未找到相关内容。";
    return hits
      .map((h) => `[文件: ${h.sourceFile}] [相似度: ${h.score.toFixed(2)}]\n${h.fullContent}`)
      .join("\n\n---\n\n");
  }
}
```

- [ ] **Step 3: 改造 WikiReadTool 实现 Tool 接口**

```ts
// 在 src/tools/search-wiki.ts 中，WikiReadTool 类改为实现 Tool 接口
// 保留 buildNameIndex 和现有的 read 逻辑，通过 execute 调用
// Tool 的 definition 写死 search_wiki 的工具定义
```

具体代码：

```ts
// src/tools/search-wiki.ts（类名从 SearchWikiTool 改为 WikiReadTool，实现 Tool 接口）
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePathSep, replaceWikiLinks } from "./wiki-resolve";
import type { Tool, ToolDefinition } from "./types";

function buildNameIndex(wikiRoot: string): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const root = path.resolve(wikiRoot);
  if (!fs.existsSync(root)) return index;
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const basename = entry.name.replace(/\.md$/i, "");
        const relative = path.relative(root, full).replace(/\\/g, "/").replace(/\.md$/i, "");
        const paths = index.get(basename) || [];
        paths.push(relative);
        index.set(basename, paths);
      }
    }
  }
  walk(root);
  return index;
}

export class WikiReadTool implements Tool {
  private wikiRoot: string;
  private nameIndex: Map<string, string[]>;

  constructor(wikiRoot = "./wiki") {
    this.wikiRoot = path.resolve(wikiRoot);
    this.nameIndex = buildNameIndex(wikiRoot);
  }

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_wiki",
      description: "读取项目 wiki 知识库中的指定文件。支持完整路径、相对路径或裸文件名（通过名称索引自动查唯一路径）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "wiki 文件路径或文件名，如 wiki/04_专业库/计算机科学与技术.md 或 哲学" },
        },
        required: ["path"],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    return this.read(String(args.path || ""));
  }

  /** 读取文件：支持完整路径 / 裸名查 index */
  read(filePath: string): string {
    const relative = filePath.replace(/^wiki[\/\\]/, "");
    const fullPath = path.resolve(path.join(this.wikiRoot, relative));

    if (!fullPath.startsWith(this.wikiRoot + path.sep) && fullPath !== this.wikiRoot) {
      return `wiki 路径越界: ${filePath}`;
    }

    // 直接命中
    if (fs.existsSync(fullPath)) {
      return this.loadFile(fullPath, relative);
    }

    // name index 查裸名
    const basename = relative.replace(/\\/g, "/").replace(/\.md$/i, "").split("/").pop() || "";
    const paths = this.nameIndex.get(basename);
    if (paths && paths.length === 1) {
      const resolved = path.resolve(path.join(this.wikiRoot, paths[0] + ".md"));
      return this.loadFile(resolved, paths[0]);
    }
    if (paths && paths.length > 1) {
      return `wiki 名称有歧义: "${basename}" 对应 ${paths.length} 个文件:\n${paths.map((p) => `  - wiki/${p}.md`).join("\n")}\n请用完整路径指定。`;
    }

    return `wiki 文件不存在: ${filePath}`;
  }

  private loadFile(fullPath: string, relative: string): string {
    let text = fs.readFileSync(fullPath, "utf8");
    text = text.replace(/^---[\s\S]*?---\s*/m, "");
    const wikiDir = normalizePathSep(path.dirname(relative));
    text = replaceWikiLinks(text, wikiDir);
    return text.trim();
  }

  get indexSize(): number { return this.nameIndex.size; }
  get dupeCount(): number { return [...this.nameIndex.values()].filter(v => v.length > 1).length; }
}
```

- [ ] **Step 4: 创建 WebSearchTool 包裹 search-web 工厂**

```ts
// src/tools/web-search.ts
import { createSearchProvider } from "./search-web";
import type { Tool, ToolDefinition } from "./types";

export class WebSearchTool implements Tool {
  private provider: ReturnType<typeof createSearchProvider>;

  constructor(providerName: string, apiKey: string) {
    this.provider = createSearchProvider(providerName, apiKey);
  }

  readonly definition: ToolDefinition = {
    type: "function",
    function: {
      name: "search_web",
      description: "实时搜索互联网，获取最新分数线、招生政策、排名等信息。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索查询词" },
          limit: { type: "number", description: "返回结果数，默认5" },
        },
        required: ["query"],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    const results = await this.provider.search(query, limit);
    if (results.length === 0) return "搜索结果为空。";
    return results.map((r) => `[${r.title}](${r.url})\n${r.snippet}`).join("\n\n");
  }
}
```

- [ ] **Step 5: 类型检查**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/types.ts src/tools/search-knowledge.ts src/tools/search-wiki.ts src/tools/web-search.ts
git commit -m "refactor: 统一Tool接口 — KnowledgeSearch/WikiRead/WebSearch 均实现 Tool"
```

---

## Phase 3: Agent 解耦

### Task 4: LLMClient 提取

**Files:**
- Create: `src/core/llm-client.ts`

- [ ] **Step 1: 从 agent.ts 提取 LLM 调用逻辑**

```ts
// src/core/llm-client.ts
import type { LLMMessage, LLMResponse, ToolCall } from "./types";
import type { ToolDefinition } from "../tools/types";

export class LLMClient {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private model: string,
  ) {}

  async chat(
    messages: LLMMessage[],
    tools?: ToolDefinition[],
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0.45,
      messages,
    };
    if (tools?.length) {
      body.tools = tools;
    }

    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`LLM call failed: ${res.status} ${errText}`);
    }

    const data = (await res.json()) as {
      choices: Array<{
        finish_reason?: string;
        message: {
          content?: string;
          tool_calls?: Array<{
            id: string;
            type: "function";
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const msg = data.choices[0]!.message;
    return {
      content: msg.content || "",
      toolCalls: (msg.tool_calls || []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
      finishReason: data.choices[0]!.finish_reason || "",
    };
  }

  /** 轻量调用（记忆提取等），无工具，temperature=0 */
  async light(systemPrompt: string, userPrompt: string): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Light LLM call failed: ${res.status}`);
    const data = (await res.json()) as {
      choices: Array<{ message: { content?: string } }>;
    };
    return data.choices[0]!.message!.content || "";
  }
}
```

- [ ] **Step 2: 类型检查 + Commit**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
git add src/core/llm-client.ts
git commit -m "refactor: 提取 LLMClient — LLM调用从agent解耦"
```

### Task 5: ToolExecutor + MessageBuilder

**Files:**
- Create: `src/core/tool-executor.ts`
- Create: `src/core/message-builder.ts`

- [ ] **Step 1: 创建 ToolExecutor**

```ts
// src/core/tool-executor.ts
import type { Tool, ToolDefinition } from "../tools/types";

export class ToolExecutor {
  constructor(private tools: Tool[]) {}

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.definition.function.name === name);
    if (!tool) return "未知工具";
    return tool.execute(args);
  }

  getDefinitions(): ToolDefinition[] {
    return this.tools.map((t) => t.definition);
  }
}
```

- [ ] **Step 2: 创建 MessageBuilder（纯函数）**

```ts
// src/core/message-builder.ts
import type { ProgressCallback, LLMMessage } from "./types";
import { SYSTEM_PROMPT } from "../prompts/system";
import type { MemoryRepo } from "./repo/memory-repo";
import type { MessageRepo } from "./repo/message-repo";

export interface BuildMessagesInput {
  sessionId: string;
  userPrompt: string;
  memoryRepo: MemoryRepo;
  messageRepo: MessageRepo;
}

export function buildMessages(input: BuildMessagesInput): LLMMessage[] {
  const messages: LLMMessage[] = [];

  // 1. 系统提示词
  messages.push({ role: "system", content: SYSTEM_PROMPT });

  // 2. 注入记忆
  const memories = input.memoryRepo.list(input.sessionId);
  if (memories.length > 0) {
    const memoryPrompt = memories
      .map((m) => `用户信息 - ${labelMap[m.key] || m.key}: ${m.value}`)
      .join("\n");
    messages.push({ role: "system", content: `## 已知用户信息\n${memoryPrompt}` });
  }

  // 3. 历史对话
  const history = input.messageRepo.loadHistory(input.sessionId);
  for (const msg of history) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls) {
        try {
          messages.push({
            role: "assistant",
            content: msg.content,
            tool_calls: JSON.parse(msg.tool_calls),
          });
        } catch {
          messages.push({ role: "assistant", content: msg.content });
        }
      } else {
        messages.push({ role: "assistant", content: msg.content });
      }
    }
  }

  // 4. 当前用户提问
  messages.push({ role: "user", content: input.userPrompt });

  return messages;
}

const labelMap: Record<string, string> = {
  user_province: "省份",
  user_score: "分数",
  user_rank: "位次",
  user_subject: "选科",
  user_major_interest: "意向专业",
  user_school_interest: "意向学校",
  user_city_preference: "城市偏好",
  user_budget_constraint: "家庭约束",
};
```

- [ ] **Step 3: 类型检查 + Commit**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
git add src/core/tool-executor.ts src/core/message-builder.ts
git commit -m "refactor: ToolExecutor + MessageBuilder — 工具调度与消息组装从agent解耦"
```

### Task 6: ChatLoop + 新 Agent 门面

**Files:**
- Create: `src/core/chat-loop.ts`
- Modify: `src/core/agent.ts`（重写为薄门面）

- [ ] **Step 1: 创建 ChatLoop（纯 ReAct 循环）**

```ts
// src/core/chat-loop.ts
import type { LLMMessage, ProgressCallback } from "./types";
import type { LLMClient } from "./llm-client";
import type { ToolExecutor } from "./tool-executor";

export class ChatLoop {
  constructor(
    private llm: LLMClient,
    private tools: ToolExecutor,
    private maxRounds = 5,
  ) {}

  async run(
    messages: LLMMessage[],
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const startTime = Date.now();

    for (let round = 0; round < this.maxRounds; round++) {
      onProgress?.({ type: "thinking", message: `思考中... (第 ${round + 1} 轮)` });
      const llmStart = Date.now();
      const { content, toolCalls } = await this.llm.chat(messages, this.tools.getDefinitions());
      const llmMs = Date.now() - llmStart;

      // 无工具调用 → 最终回答
      if (toolCalls.length === 0) {
        const totalMs = Date.now() - startTime;
        onProgress?.({ type: "done", message: `完成 (${(totalMs / 1000).toFixed(1)}s, ${llmMs}ms LLM)` });
        return content || "抱歉，无法生成回答。";
      }

      // 通知工具调用
      for (const tc of toolCalls) {
        onProgress?.({
          type: "tool_call",
          message: tc.name,
          tool: { name: tc.name, args: tc.arguments },
        });
      }

      // 添加 assistant 消息（含 tool_calls）
      messages.push({
        role: "assistant",
        content: "",
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      // 执行工具并添加结果
      for (const tc of toolCalls) {
        const toolStart = Date.now();
        const result = await this.tools.execute(tc.name, tc.arguments);
        const toolMs = Date.now() - toolStart;
        const preview = result.slice(0, 300).replace(/\n/g, " ");
        onProgress?.({
          type: "tool_result",
          message: preview + (result.length > 300 ? "..." : ""),
          tool: { name: tc.name, args: tc.arguments },
          result: { preview, fullLength: result.length },
          ms: toolMs,
        });
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    // 达到最大轮数 → 强制回答（不带 tools）
    onProgress?.({ type: "thinking", message: "达到最大搜索轮数，正在汇总..." });
    const final = await this.llm.chat(messages);
    const totalMs = Date.now() - startTime;
    onProgress?.({ type: "done", message: `完成 (${(totalMs / 1000).toFixed(1)}s)` });
    return final.content || "抱歉，无法生成回答。";
  }
}
```

- [ ] **Step 2: 重写 agent.ts 为薄门面**

```ts
// src/core/agent.ts
import { LLMClient } from "./llm-client";
import { ChatLoop } from "./chat-loop";
import { ToolExecutor } from "./tool-executor";
import { buildMessages } from "./message-builder";
import { SessionRepo } from "./repo/session-repo";
import { MessageRepo } from "./repo/message-repo";
import { MemoryRepo } from "./repo/memory-repo";
import type { ProgressCallback } from "./types";
import type { Tool } from "../tools/types";

export interface AgentConfig {
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  tools: Tool[];
}

export class GaokaoAgent {
  private llm: LLMClient;
  private chatLoop: ChatLoop;
  private toolExecutor: ToolExecutor;
  private sessionRepo = new SessionRepo();
  private messageRepo = new MessageRepo();
  private memoryRepo = new MemoryRepo();

  constructor(config: AgentConfig) {
    this.llm = new LLMClient(config.llmApiKey, config.llmBaseUrl, config.llmModel);
    this.toolExecutor = new ToolExecutor(config.tools);
    this.chatLoop = new ChatLoop(this.llm, this.toolExecutor);
  }

  /** 一次完整对话 */
  async chat(userPrompt: string, sessionId: string, onProgress?: ProgressCallback): Promise<string> {
    const messages = buildMessages({
      sessionId,
      userPrompt,
      memoryRepo: this.memoryRepo,
      messageRepo: this.messageRepo,
    });
    const answer = await this.chatLoop.run(messages, onProgress);
    this.messageRepo.saveExchange(sessionId, userPrompt, answer);
    this.sessionRepo.autoTitle(sessionId);
    return answer;
  }

  /** 轻量 LLM 调用（记忆提取等） */
  async lightCall(system: string, user: string): Promise<string> {
    return this.llm.light(system, user);
  }

  // 暴露 Repo 供 server 使用
  get sessions() { return this.sessionRepo; }
  get memories() { return this.memoryRepo; }
  get messages() { return this.messageRepo; }
}
```

- [ ] **Step 3: 类型检查 + Commit**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
git add src/core/chat-loop.ts src/core/agent.ts
git commit -m "refactor: ChatLoop提取 + agent变薄门面 — ReAct循环独立，agent只做组装"
```

---

## Phase 4: 服务层

### Task 7: SSE Handler 提取 + Server 重构

**Files:**
- Create: `src/sse-handler.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: 创建 SSE Handler**

```ts
// src/sse-handler.ts
import type { GaokaoAgent } from "./core/agent";

export function createSSEStream(
  agent: GaokaoAgent,
  sessionId: string,
  prompt: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  function sseEncode(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(sseEncode(event, data)));
      };

      const safeClose = () => {
        try { controller.close(); } catch { /* already closed */ }
      };

      try {
        const answer = await agent.chat(prompt, sessionId, (ev) => {
          send("progress", ev);
        });
        send("done", { answer });
        safeClose();

        // 异步提取记忆
        agent.memories.extractFromTurn(
          sessionId, prompt, answer,
          (sys, usr) => agent.lightCall(sys, usr),
        ).catch(() => {});
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", { error: msg });
        safeClose();
      }
    },
  });
}
```

- [ ] **Step 2: 重写 server.ts**

```ts
// src/server.ts
import { GaokaoAgent } from "./core/agent";
import { QdrantClient } from "./core/qdrant";
import { EmbeddingService } from "./core/embedding";
import { KnowledgeSearchTool } from "./tools/search-knowledge";
import { WikiReadTool } from "./tools/search-wiki";
import { WebSearchTool } from "./tools/web-search";
import { initSchema } from "./core/db";
import { createSSEStream } from "./sse-handler";

// ====== 配置 ======
const config = {
  llmApiKey: process.env.LLM_API_KEY || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
  llmModel: process.env.LLM_MODEL || "deepseek-v4-flash",
  embeddingUrl: process.env.EMBEDDING_URL || "http://127.0.0.1:1234/v1/embeddings",
  embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-qwen3-embedding-4b",
  embeddingApiKey: process.env.EMBEDDING_API_KEY || "",
  qdrantUrl: process.env.QDRANT_URL || "http://127.0.0.1:6333",
  stagingRoot: process.env.STAGING_ROOT || "./qdrant/staging",
  searchProvider: process.env.SEARCH_PROVIDER || "tavily",
  searchApiKey: process.env.SEARCH_API_KEY || "",
  port: Number(process.env.PORT) || 3211,
};

// ====== 初始化 ======
initSchema();

const qdrant = new QdrantClient(config.qdrantUrl, config.stagingRoot);
const embed = new EmbeddingService(config.embeddingUrl, config.embeddingModel, config.embeddingApiKey);

const wiki = new WikiReadTool("./wiki");
console.log(`  wiki name index: ${wiki.indexSize} unique names`);
console.log(`  wiki name dupes: ${wiki.dupeCount}`);

const agent = new GaokaoAgent({
  llmApiKey: config.llmApiKey,
  llmBaseUrl: config.llmBaseUrl,
  llmModel: config.llmModel,
  tools: [
    new KnowledgeSearchTool(qdrant, embed),
    new WebSearchTool(config.searchProvider, config.searchApiKey),
    wiki,
  ],
});

// ====== CORS ======
function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
  });
}

// ====== HTTP ======
Bun.serve({
  port: config.port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }

    // POST /api/chat
    if (path === "/api/chat" && req.method === "POST") {
      const { sessionId, prompt } = (await req.json().catch(() => ({}))) as {
        sessionId?: string; prompt?: string;
      };
      if (!sessionId || !prompt) return json({ error: "sessionId and prompt required" }, 400);
      return new Response(createSSEStream(agent, sessionId, prompt), {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors() },
      });
    }

    // GET/POST /api/sessions
    if (path === "/api/sessions" && req.method === "GET") return json(agent.sessions.list());
    if (path === "/api/sessions" && req.method === "POST") return json(agent.sessions.create());

    // GET/DELETE /api/sessions/:id
    const sessMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessMatch) {
      const sid = sessMatch[1]!;
      if (req.method === "GET") {
        const s = agent.sessions.get(sid);
        if (!s) return json({ error: "not found" }, 404);
        return json({ ...s, messages: agent.messages.loadHistory(sid) });
      }
      if (req.method === "DELETE") { agent.sessions.delete(sid); return json({ ok: true }); }
    }

    // GET/DELETE /api/sessions/:id/memories[/:key]
    const memMatch = path.match(/^\/api\/sessions\/([^/]+)\/memories(?:\/(.+))?$/);
    if (memMatch) {
      const sid = memMatch[1]!;
      const key = memMatch[2];
      if (req.method === "GET") return json(agent.memories.list(sid));
      if (req.method === "DELETE" && key) {
        agent.memories.delete(sid, decodeURIComponent(key));
        return json({ ok: true });
      }
    }

    // GET /api/health
    if (path === "/api/health") return json({ status: "ok", model: config.llmModel });

    return json({ error: "not found" }, 404);
  },
});

console.log(`🚀 高考志愿Agent API: http://127.0.0.1:${config.port}`);
```

- [ ] **Step 3: 更新前端 MemoryPanel API 路径**

```tsx
// src/web/src/MemoryPanel.tsx 中
// fetch(`/api/memories/${sessionId}`)
// 改为
// fetch(`/api/sessions/${sessionId}/memories`)
```

- [ ] **Step 4: 类型检查 + 验证服务启动**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
bun run server &
sleep 2 && curl http://127.0.0.1:3211/api/health
```

- [ ] **Step 5: Commit**

```bash
git add src/sse-handler.ts src/server.ts src/web/src/MemoryPanel.tsx
git rm src/core/session.ts src/core/memory.ts
git commit -m "refactor: SSE Handler提取 + Server RESTful化 — /api/sessions/:id/memories嵌套路径"
```

---

## Phase 5: 前端 FSM

### Task 8: ChatContext + useReducer

**Files:**
- Create: `src/web/src/ChatContext.tsx`
- Modify: `src/web/src/App.tsx`
- Modify: `src/web/src/ChatArea.tsx`

- [ ] **Step 1: 创建 ChatContext**

```tsx
// src/web/src/ChatContext.tsx
import { createContext, useContext, useReducer, type Dispatch } from "react";

// ---------- types ----------
export interface Session { id: string; title: string; message_count: number; }
export interface Message { role: "user" | "assistant"; content: string; }
export interface ToolEvent {
  type: "thinking" | "tool_call" | "tool_result" | "done";
  message: string;
  tool?: { name: string; args: Record<string, unknown> };
  result?: { preview: string; fullLength: number };
  ms?: number;
}

export type ChatStatus = "idle" | "composing" | "loading" | "streaming" | "done" | "error";

export interface ChatState {
  status: ChatStatus;
  sessionId: string | null;
  messages: Message[];
  progress: ToolEvent[];
  error: string | null;
  input: string;
}

export type ChatAction =
  | { type: "SET_SESSION"; id: string; messages: Message[] }
  | { type: "NEW_SESSION"; id: string }
  | { type: "CLEAR_SESSION" }
  | { type: "SET_INPUT"; value: string }
  | { type: "SUBMIT"; prompt: string }
  | { type: "PROGRESS"; event: ToolEvent }
  | { type: "ANSWER"; content: string }
  | { type: "ERROR"; message: string }
  | { type: "RETRY" };

function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case "SET_SESSION":
      return { ...state, status: "idle", sessionId: action.id, messages: action.messages, progress: [], error: null, input: "" };
    case "NEW_SESSION":
      return { ...state, status: "idle", sessionId: action.id, messages: [], progress: [], error: null, input: "" };
    case "CLEAR_SESSION":
      return { ...state, status: "idle", sessionId: null, messages: [], progress: [], error: null, input: "" };
    case "SET_INPUT":
      return { ...state, status: "composing", input: action.value };
    case "SUBMIT":
      return { ...state, status: "loading", input: "", progress: [], error: null, messages: [...state.messages, { role: "user", content: action.prompt }] };
    case "PROGRESS":
      return { ...state, status: "streaming", progress: [...state.progress, action.event] };
    case "ANSWER":
      return { ...state, status: "done", progress: [], messages: [...state.messages, { role: "assistant", content: action.content }] };
    case "ERROR":
      return { ...state, status: "error", progress: [], error: action.message, messages: [...state.messages, { role: "assistant", content: `❌ ${action.message}` }] };
    case "RETRY":
      return { ...state, status: "idle", error: null, progress: [] };
    default:
      return state;
  }
}

const initialState: ChatState = {
  status: "idle",
  sessionId: null,
  messages: [],
  progress: [],
  error: null,
  input: "",
};

const ChatContext = createContext<{
  state: ChatState;
  dispatch: Dispatch<ChatAction>;
} | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  return <ChatContext.Provider value={{ state, dispatch }}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
```

- [ ] **Step 2: 重写 App.tsx 使用 ChatProvider**

```tsx
// src/web/src/App.tsx
import { useState, useCallback, useEffect } from "react";
import { ChatProvider, useChat, type Session } from "./ChatContext";
import ChatArea from "./ChatArea";
import SessionList from "./SessionList";
import MemoryPanel from "./MemoryPanel";

function AppShell() {
  const { state, dispatch } = useChat();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [navOpen, setNavOpen] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions");
      setSessions((await res.json()) as Session[]);
    } catch {}
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const createSession = useCallback(async () => {
    const res = await fetch("/api/sessions", { method: "POST" });
    const s = (await res.json()) as Session;
    setSessions((prev) => [s, ...prev]);
    dispatch({ type: "NEW_SESSION", id: s.id });
    setNavOpen(false);
  }, [dispatch]);

  const switchSession = useCallback(async (id: string) => {
    setNavOpen(false);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      const data = (await res.json()) as { messages?: { role: string; content: string }[] };
      dispatch({ type: "SET_SESSION", id, messages: data.messages || [] as any });
    } catch {}
  }, [dispatch]);

  const deleteSession = useCallback(async (id: string) => {
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (state.sessionId === id) dispatch({ type: "CLEAR_SESSION" });
    fetchSessions();
  }, [state.sessionId, fetchSessions, dispatch]);

  return (
    <div className="app">
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} />}
      <aside className={`sidenav ${navOpen ? "open" : ""}`}>
        <div className="sidenav-header">
          <span className="sidenav-brand">🎓 高考志愿 Agent</span>
          <button className="btn-close" onClick={() => setNavOpen(false)} aria-label="Close">×</button>
        </div>
        <SessionList sessions={sessions} currentId={state.sessionId} onSelect={switchSession} onDelete={deleteSession} onCreate={createSession} />
        <MemoryPanel sessionId={state.sessionId} />
      </aside>
      <main className="chat-main">
        <button className="btn-hamburger" onClick={() => setNavOpen(true)} aria-label="Open menu">☰</button>
        <ChatArea dispatch={dispatch} status={state.status} sessionId={state.sessionId} messages={state.messages} progress={state.progress} input={state.input} />
      </main>
    </div>
  );
}

export default function App() {
  return <ChatProvider><AppShell /></ChatProvider>;
}
```

- [ ] **Step 3: 重写 ChatArea.tsx 纯渲染**

```tsx
// src/web/src/ChatArea.tsx（纯渲染，状态由 Context 管理）
import { useRef, useEffect, type FormEvent } from "react";
import type { Dispatch } from "react";
import type { ChatAction, ChatStatus, Message, ToolEvent } from "./ChatContext";
import ToolCallCard from "./ToolCallCard";

interface Props {
  dispatch: Dispatch<ChatAction>;
  status: ChatStatus;
  sessionId: string | null;
  messages: Message[];
  progress: ToolEvent[];
  input: string;
}

export default function ChatArea({ dispatch, status, sessionId, messages, progress, input }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, progress]);

  // 切换会话时中止旧请求
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [sessionId]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const prompt = input.trim();
    if (!prompt || status === "loading" || status === "streaming") return;

    let sid = sessionId;
    if (!sid) {
      const res = await fetch("/api/sessions", { method: "POST" });
      const s = (await res.json()) as { id: string };
      sid = s.id;
      dispatch({ type: "NEW_SESSION", id: s.id });
    }

    dispatch({ type: "SUBMIT", prompt });
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sid, prompt }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          if (!part.trim()) continue;
          const lines = part.split("\n");
          let eventType = "", dataStr = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            if (line.startsWith("data: ")) dataStr = line.slice(6);
          }
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            if (eventType === "progress") dispatch({ type: "PROGRESS", event: payload });
            else if (eventType === "done") dispatch({ type: "ANSWER", content: payload.answer || "(空回答)" });
            else if (eventType === "error") dispatch({ type: "ERROR", message: payload.error || "未知错误" });
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      dispatch({ type: "ERROR", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const hasContent = messages.length > 0 || progress.length > 0 || status === "loading" || status === "streaming";

  return (
    <div className="chat-area">
      <div className={`chat-body ${hasContent ? "" : "centered"}`}>
        {!hasContent ? (
          <div className="welcome">
            <h1 className="welcome-title">高考志愿填报助手</h1>
            <p className="welcome-sub">告诉我你的省份、分数和意向专业，我来帮你分析。</p>
            <div className="quick-actions">
              <button onClick={() => dispatch({ type: "SET_INPUT", value: "河南580分能上什么计算机学校？" })}>河南580分能上什么计算机学校？</button>
              <button onClick={() => dispatch({ type: "SET_INPUT", value: "计算机专业适不适合普通家庭？" })}>计算机专业适不适合普通家庭？</button>
              <button onClick={() => dispatch({ type: "SET_INPUT", value: "法学就业前景怎么样？" })}>法学就业前景怎么样？</button>
            </div>
          </div>
        ) : (
          <div className="messages">
            {messages.map((msg, i) => (
              <div key={i} className={`msg ${msg.role}`}>
                <div className="msg-bubble">{msg.content}</div>
              </div>
            ))}
            {progress.length > 0 && (
              <div className="progress-block">
                {progress.map((ev, i) => <ToolCallCard key={i} event={ev} />)}
              </div>
            )}
            {(status === "loading" || status === "streaming") && progress.length === 0 && (
              <div className="msg assistant"><div className="msg-bubble thinking">思考中...</div></div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
      <div className="input-bar">
        <form onSubmit={handleSubmit} className="input-form">
          <input type="text" value={input} onChange={(e) => dispatch({ type: "SET_INPUT", value: e.currentTarget.value })} placeholder="输入你的问题..." disabled={status === "loading" || status === "streaming"} />
          <button type="submit" disabled={!input.trim() || status === "loading" || status === "streaming"}>
            {status === "loading" || status === "streaming" ? "..." : "→"}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 类型检查 + Commit**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
git add src/web/src/ChatContext.tsx src/web/src/App.tsx src/web/src/ChatArea.tsx
git commit -m "refactor: 前端FSM — ChatContext+useReducer，ChatArea纯渲染，6状态8action"
```

---

## Phase 6: CLI 适配 + 清理

### Task 9: CLI 适配新架构

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: 更新 CLI 使用新 agent API**

CLI 只需更新 import 路径和构造方式。`GaokaoAgent` 的新构造函数接受 `{ llmApiKey, llmBaseUrl, llmModel, tools }`。CLI 不再需要手动创建 `SearchKnowledgeTool` / `SearchWikiTool` 等——它们作为 `tools` 数组传入。

```ts
// src/cli.ts 中构造 agent 部分改为：
const wiki = new WikiReadTool("./wiki");
const agent = new GaokaoAgent({
  llmApiKey: config.llmApiKey,
  llmBaseUrl: config.llmBaseUrl,
  llmModel: config.llmModel,
  tools: [
    new KnowledgeSearchTool(qdrant, embed),
    new WebSearchTool(config.searchProvider, config.searchApiKey),
    wiki,
  ],
});
```

CLI 的 `agent.onProgress = ...` 改为在 `agent.chat(prompt, sessionId, onProgress)` 中传入第三个参数。

- [ ] **Step 2: 类型检查**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
```

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "refactor: CLI适配新Agent API — tools数组注入，onProgress参数化"
```

### Task 10: 最终验证

- [ ] **Step 1: 全量类型检查**

```bash
cd D:/zhangxuefeng/agent-prototype && bun run typecheck
```

期望：仅有 `search-knowledge.ts:40` 的预存类型错误（非本次引入）。

- [ ] **Step 2: 启动服务端验证**

```bash
bun run server
# 期望输出：
#  wiki name index: 1274 unique names
#  wiki name dupes: 35 (...)
# 🚀 高考志愿Agent API: http://127.0.0.1:3211
```

- [ ] **Step 3: API 测试**

```bash
curl http://127.0.0.1:3211/api/health
# → {"status":"ok","model":"deepseek-v4-flash"}

SID=$(curl -s -X POST http://127.0.0.1:3211/api/sessions -H "Content-Type: application/json" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -X POST http://127.0.0.1:3211/api/chat -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\",\"prompt\":\"你好\"}" --max-time 30
# 期望 SSE 流式输出 event:done
```

- [ ] **Step 4: Commit + tag**

```bash
git add -A
git commit -m "chore: v0.4.0 重构完成 — 最终验证通过"
git tag v0.4.0
```

---

## 执行顺序总结

```
Phase 1: types.ts → db.ts → repo/*.ts               (基础)
Phase 2: tools/types.ts → 三个工具改造              (工具层)
Phase 3: llm-client.ts → tool-executor.ts → message-builder.ts → chat-loop.ts → agent.ts  (核心解耦)
Phase 4: sse-handler.ts → server.ts → MemoryPanel API 路径  (服务层)
Phase 5: ChatContext.tsx → App.tsx → ChatArea.tsx     (前端)
Phase 6: cli.ts → 最终验证                           (收尾)
```

每个 Phase 结束时 `bun run typecheck` 必须通过。
