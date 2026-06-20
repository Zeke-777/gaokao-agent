# 高考志愿 Agent 原型 — 项目状态

> 版本: v1.0.0 | 日期: 2026-06-19 | 状态: 功能完整

---

## 一、项目定位

张雪峰风格的高考志愿填报 AI Agent 原型。核心思路：**知识库检索 + 实时搜索 + Wiki 深度阅读 + 大模型生成**。

## 二、技术栈

| 层级 | 技术 | 说明 |
|------|------|------|
| 语言 | TypeScript strict | 全栈 |
| 运行时 | Bun | 包管理 + 运行 + SQLite |
| 前端 | React 19 + Vite 6 | SPA，极简风格，useReducer FSM |
| 后端 | Bun.serve | HTTP API，SSE 流式 |
| 数据库 | bun:sqlite | 会话 + 消息，2 表 |
| 向量库 | Qdrant 1.17.1 | 5 Collection，10,309 向量 |
| LLM | DeepSeek V4 Flash | OpenAI 兼容接口 |
| Embedding | DashScope | text-embedding-v4, 1024 维 |
| 搜索 | Tavily API | 解耦设计，可换 Brave |

## 三、目录结构

```
agent-prototype/
├── src/
│   ├── cli.ts                      ← CLI REPL 入口
│   ├── server.ts                   ← HTTP API 服务 (:3211)
│   ├── sse-handler.ts              ← SSE 流式响应
│   ├── core/
│   │   ├── agent.ts                ← GaokaoAgent — 薄门面（~42行）
│   │   ├── chat-loop.ts            ← ChatLoop — 多轮 ReAct 循环（~85行）
│   │   ├── tool-executor.ts        ← ToolExecutor — 统一工具执行（~16行）
│   │   ├── message-builder.ts      ← buildMessages() — 构建 LLM 消息列表
│   │   ├── llm-client.ts           ← LLMClient — LLM API 调用封装
│   │   ├── config.ts               ← 共享配置（CLI/Server 共用）
│   │   ├── create-agent.ts         ← Agent 工厂函数
│   │   ├── types.ts                ← 共享类型（ProgressEvent, LLMMessage, ToolCall）
│   │   ├── db.ts                   ← SQLite 单例 + schema 初始化
│   │   ├── repo/
│   │   │   ├── session-repo.ts     ← SessionRepo — 会话 CRUD
│   │   │   └── message-repo.ts     ← MessageRepo — 消息原子写入
│   │   ├── qdrant.ts               ← Qdrant 客户端 + staging 文件读取
│   │   └── embedding.ts            ← Embedding 服务封装
│   ├── tools/
│   │   ├── types.ts                ← Tool 接口 + ToolDefinition
│   │   ├── search-knowledge.ts     ← 知识库检索（5集合，topK=5）
│   │   ├── search-wiki.ts          ← Wiki 文件读取 + name index 自动歧义解析
│   │   ├── web-search.ts           ← Web 搜索（Tavily/Brave）
│   │   ├── wiki-resolve.ts         ← [[链接]] 栈式解析（2分支）
│   │   └── search-web/             ← 搜索引擎 provider
│   │       ├── types.ts / tavily.ts / brave.ts / index.ts
│   ├── prompts/
│   │   └── system.ts               ← 系统提示词（工具能力由 definition 承载）
│   └── web/                        ← React 前端
│       ├── vite.config.ts
│       └── src/
│           ├── App.tsx              ← 根组件
│           ├── ChatContext.tsx      ← useReducer（idle/busy, 8 action）
│           ├── ChatArea.tsx         ← 纯渲染 + SSE 消费
│           ├── SessionList.tsx / ToolCallCard.tsx / main.tsx
│           └── styles.css
├── wiki/                           ← 知识库本体 (01_~07_, 1316 文件)
├── qdrant/                         ← 向量库
│   ├── staging/                    ← 导入源文件（1310 个 md）
│   ├── scripts/
│   │   ├── sync-wiki-to-staging.ts ← wiki → staging 同步
│   │   ├── ingest-staging.cjs      ← staging → Qdrant embedding 入库
│   │   └── create-collections.cjs  ← 创建 Qdrant 集合
│   └── config/
│       ├── qdrant.yaml
│       └── collections.template.json
├── sqlite/                         ← 录取数据库脚本（抓取/导入/初始化/查询）
├── data/                           ← 运行时数据 (gitignore)
├── docs/
│   ├── PROJECT_STATUS.md           ← 本文件
│   └── code-conventions.md         ← 代码规范
└── package.json
```

## 四、Agent 架构

### 4.1 模块拆分

```
GaokaoAgent (~42行)
├── buildMessages()   → 系统提示 + 历史加载
├── ChatLoop.run()    → 多轮循环（max 5）
│   ├── LLMClient      → LLM API
│   └── ToolExecutor   → 工具查找+执行
├── SessionRepo       → 会话 CRUD
└── MessageRepo       → 消息事务写入
```

### 4.2 Tool 统一接口

所有工具实现 `Tool` 接口，通过 `AgentConfig.tools: Tool[]` 注入：

| 工具 | 功能 | 参数 |
|------|------|------|
| `search_knowledge` | 5 集合语义检索，返回完整文档 | query, topK(默认5), collections |
| `search_web` | Tavily/Brave 实时搜索 | query, limit |
| `search_wiki` | wiki 文件读取 + name index 自动歧义 | path（路径或文件名） |

### 4.3 Wiki [[链接]] 解析

`wiki-resolve.ts` 提供三个纯函数，被 `qdrant.ts` 和 `search-wiki.ts` 共用：

- 裸引用（如 `[[计算机科学与技术]]`）→ 原样保留
- 路径引用（含 `/` 或以 `..` 开头）→ 栈式解析为 `[[wiki/xx/yy.md]]`

### 4.4 search_wiki name index

启动时递归扫描 wiki 目录构建 `Map<文件名, 路径列表>`（1274 名，35 重名）：
- 路径直接命中 → 读文件
- 不命中 → name index 查文件名 → 全读拼接返回（不再报错）

### 4.5 前端 FSM

- **2 状态**: `idle` | `busy`
- **10 action**: SET_SESSION / NEW_SESSION / CLEAR_SESSION / SET_INPUT / SUBMIT / PROGRESS / TOKEN / ANSWER / ERROR / CANCEL
- 收到 `done` 事件后主动 `break`，不依赖服务端关流

## 五、启动方式

```bash
cd D:/zhangxuefeng/agent-prototype

# 启动 Qdrant（Windows 用 qdrant.exe，其他系统用 qdrant）
qdrant --config-path ./qdrant/config/qdrant.yaml

# 后端 API
bun run server          # http://127.0.0.1:3211

# 前端 dev
bun run web             # http://127.0.0.1:3210

# CLI REPL
bun run cli
```

## 六、API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | SSE 流式对话 { sessionId, prompt } |
| GET | `/api/sessions` | 列出会话 |
| POST | `/api/sessions` | 创建会话 |
| GET | `/api/sessions/:id` | 获取会话 + 消息历史 |
| DELETE | `/api/sessions/:id` | 删除会话 |
| PATCH | `/api/sessions/:id` | 重命名会话 { title } |
| GET | `/api/health` | 健康检查 |

## 七、数据库

```
agent.db          — sessions, messages（会话/消息，2 表）
gaokao_2025.db    — 录取数据（87万+ 条）
```

## 八、向量库

| 集合 | 来源 | 文件数 | 向量数 |
|------|------|:-----:|:-----:|
| gaokao_policies_rules | 01_政策规则 | 39 | 422 |
| gaokao_province_data | 02_省份数据 | 64 | 311 |
| gaokao_schools | 03_院校库 | 993 | 6,876 |
| gaokao_majors | 04_专业库 | 176 | 2,341 |
| gaokao_style_cases | 05+06 | 38 | 359 |
| **合计** | | **1,310** | **10,309** |

重建流程：`sync-wiki-to-staging.ts` → `ingest-staging.cjs`

## 九、已知问题

| 问题 | 严重度 | 说明 |
|------|--------|------|
| 无上下文压缩 | 中 | 长对话 token 积累 |
| Tavily API 需付费 | 中 | 免费额度有限 |
| 前端 Markdown 性能 | 低 | 流式输出时每个 token 都触发 Markdown 重渲染 |
| SSE 竞态窗口极小 | 低 | abort 和事件处理之间的单 tick 窗口，已用 activeSidRef 缓解 |

### 代码审查记录 (2026-06-19)

以下问题经全面审查确认，均为 UX 优化项，不影响系统运行。

| # | 问题 | 文件 | 状态 | 说明 |
|---|------|------|------|------|
| 1 | done 进度事件在客户端显示为工具卡片 | ChatArea.tsx:148 | **非问题** | 显示的是模型耗时汇总信息（如"完成 3.2s, 1200ms LLM"），对用户有参考价值，不需要过滤 |
| 2 | 删除活跃会话显示"已取消"消息 | ChatArea.tsx:81 | **非问题** | 是正向反馈，告知用户请求已被中止 |
| 3 | 快速双击可并发请求 | ChatArea.tsx:90 | UX 优化 | React 18 批处理使 isSubmitting 不立即生效，极端操作下可能重复提交。可用 ref 替代 state 做守卫 |
| 4 | createSession/switchSession 空 catch{} | App.tsx:49,67 | UX 优化 | 网络/服务器错误被静默吞掉，用户零反馈。可添加 toast 提示 |
| 5 | Loading dots 与流式内容同时显示 | ChatArea.tsx:228 | UX 优化 | isBusy 无条件显示三点动画，流式传输时与内容重叠。可恢复 `progress.length === 0 && !streamingContent` 条件 |
| 6 | abort 后不保存消息 | agent.ts:80 | **设计决策** | 用户主动取消，不保存半成品到 DB，避免污染上下文 |
| 7 | CANCEL 不保留 toolEvents | ChatContext.tsx:57 | **设计决策** | 取消后无需显示之前的工具调用，进度卡片已在 UI 展示过 |
| 8 | 取消后输入框内容丢失 | ChatArea.tsx:164 | **设计决策** | 用户主动取消，输入内容可重新输入，非关键数据 |

## 十、v0.4.0 主要变更 (2026-06-17)

Agent 解耦重构 + 架构规范化。详见 git log。

## 十一、v0.5.0 主要变更 (2026-06-17)

1. **移除用户画像功能**：删除 memory-repo.ts、constants.ts、MemoryPanel.tsx、memories 表、lightCall
2. **Wiki 链接解析重构**：三分支→两分支，统一基于当前目录解析；输出包裹 `[[...]]`；修正 6 处跨目录引用
3. **search_wiki name index**：多文件歧义自动全读拼接，不再报错推给 LLM
4. **Qdrant 向量库重建**：5 集合（删 score_rules），10,309 向量；source 前缀处理修正
5. **系统提示词优化**：工具能力由 tool definition 承载，提示词只保留策略指导；补充两类引用说明
6. **search_knowledge**：topK 默认 3→5，删除废弃 query() 方法
7. **wiki→staging 同步脚本**：一键从 wiki 同步到 staging
8. **SSE 流关闭修复**：前端收到 done/error 后主动 break + cancel reader
9. **死代码清理**：SessionRepo.touch()、LLMClient.light()

## 十二、v0.5.1 主要变更 (2026-06-18)

1. **LLM 流式传输**：新增 `LLMClient.chatStream()`，逐 token 推送到前端，替代原非流式调用
2. **工具调用历史持久化**：`toolEvents` 随消息存入 DB `messages.tool_events` 列，前端折叠展示
3. **LLM 生成会话标题**：`generateTitle()` fire-and-forget，首次问答后异步生成
4. **会话重命名**：PATCH `/api/sessions/:id`，前端 ✎ 按钮编辑
5. **SSE 中断支持**：AbortSignal 从 SSE handler → agent → chat-loop → llm-client 全链路透传
6. **最大轮次强制回答**：5 轮后注入系统消息 + 无 tools 的最终 LLM 调用
7. **前端 streamingContent**：新增 TOKEN action，流式内容实时渲染 + 光标动画
8. **自动滚动优化**：只在用户靠近底部时自动滚动，翻看历史不打断

## 十三、v0.6.0 主要变更 (2026-06-18)

1. **UI 全面重设计**：暖色卡片风格，渐变橙色用户气泡，消息入场动画
2. **Markdown 渲染**：助手回答支持 GFM（表格、代码块、引用等）
3. **工具调用展示优化**：隐藏 thinking 事件，只显示 tool_call/tool_result
4. **回到底部按钮**：滚动超过 200px 时显示浮动按钮
5. **生成中禁止切换会话**：防止误打断，侧边栏禁用态
6. **欢迎页提交自动创建会话**：侧边栏实时刷新
7. **abort 信号全链路透传**：Tool 接口加 signal 参数，fetch 立即中断
8. **旧库 CASCADE 迁移**：启动时检测并自动重建 messages 表
9. **saveExchange try/finally**：abort 时仍保存用户消息+部分结果
10. **标题生成 fallback**：LLM 失败时用首条用户消息截断
11. **死代码清理**：chat() 非流式方法、重复 ToolEvent 类型、冗余手删消息
12. **Bug 修复**：CORS PATCH、db.ts 双重初始化、SSE 竞态、tool_events 损坏容错、CASCADE 迁移事务

## 十四、v1.0.0 主要变更 (2026-06-19)

### UI 重构
1. **窄侧边栏布局**：从 280px 改为 60px 图标栏，参考智谱 AI 设计
2. **侧边栏展开/收起**：点击按钮切换宽度，新建会话自动展开
3. **移动端汉堡菜单**：小屏幕下显示汉堡按钮打开侧边栏
4. **欢迎页更新**：标题改为"高考志愿填报助手"，按钮改为分数选校/专业分析/就业前景

### 输入体验
5. **textarea 自适应高度**：输入框随内容自动调整，最大高度 150px
6. **Shift+Enter 换行**：支持多行输入
7. **停止生成按钮**：红色方形按钮，点击中断当前请求

### 滚动与导航
8. **上下滚动按钮**：输入框右上角显示，接近顶部/底部时自动隐藏
9. **渐变动画**：按钮出现/消失有 0.3s 淡入淡出效果
10. **移动端适配**：窄屏下使用固定定位避免溢出

### 工具调用显示
11. **tool_call 强制展开**：参数始终可见，不能收起
12. **tool_result 简略显示**：绿色边框 + "完成 (耗时)" + 预览文本
13. **三点跳动动画**：AI 工作时显示跳动圆点反馈

### 稳定性修复
14. **SSE 断连卡死修复**：AbortError 时 dispatch CANCEL 重置状态
15. **双击提交防护**：添加 isSubmitting 状态防止重复提交（注：React 18 批处理下仍存在极小竞态窗口，见已知问题）
16. **AbortController 内存泄漏修复**：组件卸载时自动 abort
17. **创建会话错误处理**：添加 res.ok 检查 + 外层 catch
18. **done 事件过滤**：agent.ts 中过滤 done 事件不存入工具调用历史（客户端仍显示耗时汇总，属正常行为）
19. **中断不保存消息**：abort 时不写入不完整的历史，避免污染上下文
20. **会话切换 abort**：切换/删除会话时自动中止进行中的请求

### 安全与健壮性
21. **DSML 标签过滤**：前端检测特殊标签时用纯文本渲染，防止 Markdown 解析卡死
22. **存储前过滤**：后端保存消息前过滤特殊标签，防止历史加载卡死
23. **system prompt 强化**：禁止汇总阶段输出工具调用格式
24. **res.body 空值检查**：避免极端情况下的 TypeError

### 其他优化
25. **消息对齐**：用户消息靠右 75%，AI 回复靠左 85%
26. **字体优化**：改用 Inter + SF Pro Display
27. **时间信息**：系统提示词加入 2026 年，优先参考 2025 年数据
