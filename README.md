# 高考志愿填报 Agent

> 张雪峰风格的高考志愿填报分析助手 — 基于 RAG + 工具调用的智能问答系统

一个面向高考考生和家长的志愿填报咨询 Agent。它不讲废话，不编数据，先给结论再讲现实，像一个愿意讲真话的老师。

---

## 功能特性

- **知识库问答** — 基于 Qdrant 向量检索，覆盖院校、专业、录取数据、政策规则、风格案例五大维度
- **联网搜索** — 支持 Tavily / Brave 搜索引擎，获取最新资讯
- **Wiki 追读** — 知识库中的 `[[引用]]` 可一键展开为详细内容
- **多轮对话** — 支持会话管理、历史记录、SSE 流式输出
- **Web 前端** — React + Vite 构建的聊天界面
- **CLI 模式** — 命令行直接对话，适合开发者调试

---

## 技术栈

| 层级        | 技术                                                  |
| --------- | --------------------------------------------------- |
| 运行时       | [Bun](https://bun.sh/docs/installation)             |
| 语言        | TypeScript                                          |
| LLM       | DeepSeek（OpenAI 兼容接口）                               |
| Embedding | DashScope `text-embedding-v4`（1024 维）               |
| 向量数据库     | [Qdrant](https://github.com/qdrant/qdrant/releases) |
| 关系数据库     | `bun:sqlite`                                        |
| 前端        | React 19 + Vite 6                                   |
| 搜索引擎      | Tavily / Brave                                      |

---

## 快速开始

### 前置要求

- [Bun](https://bun.sh/docs/installation) >= 1.0
- [Qdrant](https://github.com/qdrant/qdrant/releases) 向量数据库（本地或远程）

### 安装

```bash
git clone https://github.com/Zeke-777/gaokao-agent.git
cd gaokao-agent
bun install
```

### 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，填入你的 API Key：

```env
# LLM（DeepSeek 或其他 OpenAI 兼容接口）
LLM_API_KEY=sk-your-key-here
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash

# Embedding（阿里云 DashScope）
EMBEDDING_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings
EMBEDDING_MODEL=text-embedding-v4
EMBEDDING_API_KEY=your-dashscope-key
VECTOR_SIZE=1024
BATCH_SIZE=10

# Qdrant
QDRANT_URL=http://127.0.0.1:6333

# 搜索引擎（二选一）
SEARCH_PROVIDER=tavily
SEARCH_API_KEY=your-search-key
```

### 启动 Qdrant

从 [GitHub Releases](https://github.com/qdrant/qdrant/releases) 下载 `qdrant.exe`，配置好 PATH 或使用实际路径启动，运行后默认监听 `localhost:6333`：

```bash
# Windows
qdrant.exe --config-path qdrant/config/qdrant.yaml
```

### 初始化知识库

Qdrant 启动后，创建集合并导入数据：

```bash
# 创建 Qdrant 集合
bun run qdrant/scripts/create-collections.cjs

# 从 wiki 同步数据到 staging 目录
bun run qdrant/scripts/sync-wiki-to-staging.ts

# 导入数据到 Qdrant
bun run qdrant/scripts/ingest-staging.cjs
```

### 启动服务

**方式一：Web 界面（推荐）**

需要同时启动后端 API 和前端开发服务器，分别在两个终端执行：

```bash
# 终端 1 — 启动后端 API 服务（默认 http://127.0.0.1:3211）
bun run server

# 终端 2 — 启动前端开发服务器（默认 http://127.0.0.1:3210）
bun run web
```

**方式二：命令行模式**

无需启动前端，直接在终端对话，适合开发调试：

```bash
bun run cli
```

---

## 项目结构

```
├── src/
│   ├── cli.ts                  # CLI 入口
│   ├── server.ts               # HTTP API 服务
│   ├── sse-handler.ts          # SSE 流式响应
│   ├── core/
│   │   ├── agent.ts            # Agent 核心逻辑
│   │   ├── chat-loop.ts        # 对话循环
│   │   ├── config.ts           # 配置管理
│   │   ├── create-agent.ts     # Agent 工厂
│   │   ├── db.ts               # SQLite 数据库
│   │   ├── embedding.ts        # Embedding 服务
│   │   ├── llm-client.ts       # LLM 客户端
│   │   ├── message-builder.ts  # 消息构建
│   │   ├── qdrant.ts           # Qdrant 客户端
│   │   ├── tool-executor.ts    # 工具执行器
│   │   ├── types.ts            # 类型定义
│   │   └── repo/               # 数据仓库
│   ├── prompts/
│   │   └── system.ts           # 系统提示词（张雪峰风格）
│   ├── tools/
│   │   ├── search-knowledge.ts # 知识库检索
│   │   ├── search-wiki.ts      # Wiki 追读
│   │   ├── web-search.ts       # 联网搜索
│   │   └── search-web/         # 搜索引擎适配
│   └── web/                    # React 前端
├── qdrant/
│   ├── config/                 # 集合配置模板
│   ├── scripts/                # 数据导入脚本
│   └── staging/                # 本地 staging 数据（不入 git）
├── wiki/                       # Obsidian 知识库
├── sqlite/                     # SQLite 数据文件
└── .env.example                # 环境变量模板
```

---

## 工具说明

### `search_knowledge` — 知识库检索

从 Qdrant 向量数据库中检索相关知识，支持按集合（collection）过滤：

| Collection       | 说明             |
| ---------------- | -------------- |
| `policies_rules` | 政策规则、赋分、提前批、特招 |
| `province_data`  | 各省录取数据         |
| `schools`        | 学校画像、优势专业、报考风险 |
| `majors`         | 专业前景、行业趋势      |
| `style_cases`    | 张雪峰风格案例、家庭约束模板 |

### `search_wiki` — Wiki 追读

读取 Obsidian wiki 中的详细文档，支持 `[[引用]]` 展开。

### `web_search` — 联网搜索

调用 Tavily 或 Brave 搜索引擎获取最新信息。

---

## 回答风格

这个 Agent 模仿张雪峰的说话风格：

- **先说结论**，再说原因、风险和替代方案
- **讲代价**，不只讲好处
- **位次优先于分数**，如果用户只给分数没给位次，会明确提醒
- **不编造数据**，没有精确数据时会说明是经验判断
- **对普通家庭**，优先讲投入产出比
- **去掉 AI 味**，像一个懂行、愿意讲真话的老师

---

## 贡献

欢迎提交 Issue 和 Pull Request。

---

## License

MIT
