import { QdrantClient } from "./core/qdrant";
import { EmbeddingService } from "./core/embedding";
import { SearchKnowledgeTool } from "./tools/search-knowledge";
import { createSearchProvider } from "./tools/search-web";
import { GaokaoAgent } from "./core/agent";
import { createSession, listSessions, getSession } from "./core/session";
import { listMemories, deleteMemory, clearMemories, extractMemoriesFromTurn } from "./core/memory";
import { getDb } from "./core/db";

// ========== 配置 ==========
const config = {
  llmApiKey: process.env.DEEPSEEK_API_KEY || "",
  llmBaseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com",
  llmModel: process.env.LLM_MODEL || "deepseek-v4-flash",
  embeddingUrl:
    process.env.EMBEDDING_URL || "http://127.0.0.1:1234/v1/embeddings",
  embeddingModel:
    process.env.EMBEDDING_MODEL || "text-embedding-qwen3-embedding-4b",
  qdrantUrl: process.env.QDRANT_URL || "http://127.0.0.1:6333",
  stagingRoot:
    process.env.STAGING_ROOT ||
    "./vendor/qdrant/staging",
  searchProvider: process.env.SEARCH_PROVIDER || "tavily",
  searchApiKey: process.env.SEARCH_API_KEY || "",
};

// ========== 初始化 ==========
getDb(); // 初始化 SQLite
const qdrant = new QdrantClient(config.qdrantUrl, config.stagingRoot);
const embed = new EmbeddingService(config.embeddingUrl, config.embeddingModel);
const searchKnowledge = new SearchKnowledgeTool(qdrant, embed);
const searchProvider = createSearchProvider(
  config.searchProvider,
  config.searchApiKey,
);

const agent = new GaokaoAgent({
  llmApiKey: config.llmApiKey,
  llmBaseUrl: config.llmBaseUrl,
  llmModel: config.llmModel,
  searchKnowledge,
  searchProvider,
});

// ========== 进度展示 ==========
agent.onProgress = (event) => {
  switch (event.type) {
    case "thinking":
      process.stdout.write(`  💭 ${event.message}`);
      break;
    case "tool_call": {
      const toolName = event.tool?.name || event.message;
      const args = event.tool?.args || {};
      const queryStr = String(args.query || JSON.stringify(args)).slice(0, 100);
      console.log(`\n  ╭─ 🔧 Tool Call ─────────────────────────`);
      console.log(`  │  name: ${toolName}`);
      console.log(`  │  args: ${JSON.stringify(args)}`.slice(0, 150));
      console.log(`  ╰──────────────────────────────────────`);
      break;
    }
    case "tool_result": {
      const preview = event.message.slice(0, 200);
      const ms = event.ms || 0;
      const lines = preview.split("\\n").slice(0, 5);
      console.log(`  ╭─ 📥 Tool Result (${ms}ms) ──────────────────`);
      for (const line of lines) {
        console.log(`  │  ${line.slice(0, 100)}`);
      }
      if (event.message.length > 200) console.log(`  │  ... (共 ${event.result?.fullLength || event.message.length} 字符)`);
      console.log(`  ╰──────────────────────────────────────`);
      break;
    }
    case "done":
      console.log(`\n  ✅ ${event.message}\n`);
      break;
  }
};

// ========== 帮助 ==========
function showHelp() {
  console.log(`
┌──────────────────────────────────────────────────────────┐
│  高考志愿 Agent — 命令列表                                │
├──────────────────────────────────────────────────────────┤
│  /new &lt;问题&gt;      创建新会话并提问                        │
│  /memory           查看当前记忆（用户画像）                 │
│  /memory clear     清空所有记忆                            │
│  /memory del &lt;key&gt; 删除指定记忆                          │
│  /sessions         列出所有会话                             │
│  /switch &lt;id&gt;     切换到指定会话                          │
│  /help             显示本帮助                               │
│  /exit             退出                                     │
├──────────────────────────────────────────────────────────┤
│  直接输入文字即对当前会话提问                               │
└──────────────────────────────────────────────────────────┘
`);
}

// ========== REPL ==========
async function repl() {
  console.log("\n🎓 高考志愿 Agent — 张雪峰风格\n");
  console.log("输入 /help 查看命令，输入 /new 开始新会话\n");

  let currentSessionId: string | null = null;

  const showPrompt = () => {
    if (currentSessionId) {
      const session = getSession(currentSessionId);
      const title = session?.title || currentSessionId;
      const count = session?.message_count || 0;
      process.stdout.write(`\n🎓 [${title.slice(0, 30)}](${count}轮) > `);
    } else {
      process.stdout.write("\n🎓 > ");
    }
  };

  showPrompt();

  for await (const line of console) {
    const input = line.trim();
    if (!input) {
      showPrompt();
      continue;
    }

    // ----- 命令处理 -----
    if (input.startsWith("/")) {
      const parts = input.split(/\s+/);
      const cmd = parts[0]!.toLowerCase();
      const arg = parts.slice(1).join(" ");

      switch (cmd) {
        case "/exit":
        case "/quit":
          console.log("再见！");
          process.exit(0);

        case "/help":
          showHelp();
          break;

        case "/new": {
          if (!arg) {
            console.log("用法: /new <问题>");
            break;
          }
          const session = createSession();
          currentSessionId = session.id;
          console.log(`\n📝 新会话: ${session.id}`);
          console.log("🔍 Agent 正在检索和分析...\n");

          try {
            const answer = await agent.chat(arg, session.id);
            console.log(`\n${answer}\n`);

            // 自动提取本会话记忆
            try {
              await extractMemoriesFromTurn(session.id, arg, answer, (sys, usr) =>
                agent.lightCall(sys, usr),
              );
            } catch {
              // 记忆提取失败静默
            }
          } catch (err) {
            console.error("❌ 错误:", err);
          }
          break;
        }

        case "/memory": {
          if (arg === "clear") {
            if (!currentSessionId) { console.log("请先创建会话"); break; }
            clearMemories(currentSessionId);
            console.log("本会话记忆已清空");
          } else if (arg.startsWith("del ")) {
            if (!currentSessionId) { console.log("请先创建会话"); break; }
            deleteMemory(currentSessionId, arg.slice(4));
            console.log(`已删除记忆: ${arg.slice(4)}`);
          } else {
            if (!currentSessionId) { console.log("请先创建会话"); break; }
            const memories = listMemories(currentSessionId);
            if (memories.length === 0) {
              console.log("本会话暂无记忆");
            } else {
              console.log("\n🧠 本会话记忆:\n");
              for (const m of memories) {
                console.log(`  ${m.key}: ${m.value}  [${m.category}]`);
              }
            }
          }
          break;
        }

        case "/sessions": {
          const sessions = listSessions();
          if (sessions.length === 0) {
            console.log("暂无历史会话");
          } else {
            console.log("\n📋 历史会话:\n");
            for (const s of sessions) {
              const marker = s.id === currentSessionId ? " *" : "  ";
              console.log(
                `${marker} ${s.id} — ${s.title || "(无标题)"} — ${s.message_count} 轮 — ${s.updated_at}`,
              );
            }
          }
          break;
        }

        case "/switch": {
          if (!arg) {
            console.log("用法: /switch <会话ID>");
            break;
          }
          const session = getSession(arg);
          if (!session) {
            console.log(`会话 ${arg} 不存在`);
          } else {
            currentSessionId = arg;
            console.log(`已切换到会话: ${session.title || arg} (${session.message_count} 轮历史)`);
          }
          break;
        }

        default:
          console.log(`未知命令: ${cmd}，输入 /help 查看帮助`);
      }
      showPrompt();
      continue;
    }

    // ----- 普通提问（需先有会话） -----
    if (!currentSessionId) {
      console.log("请先创建会话: /new <你的问题>");
      showPrompt();
      continue;
    }

    if (!config.llmApiKey) {
      console.log("❌ 请先设置 DEEPSEEK_API_KEY 环境变量");
      showPrompt();
      continue;
    }

    console.log("🔍 Agent 开始工作...\n");
    try {
      const answer = await agent.chat(input, currentSessionId);
      console.log(`\n${answer}\n`);

      // 自动提取本会话记忆
      try {
        await extractMemoriesFromTurn(currentSessionId, input, answer, (sys, usr) =>
          agent.lightCall(sys, usr),
        );
      } catch {
        // 静默
      }
    } catch (err) {
      console.error("❌ 错误:", err);
    }

    showPrompt();
  }
}

// 如果传了命令行参数，走单次模式
const cliArg = process.argv[2];
if (cliArg && !cliArg.startsWith("/")) {
  const session = createSession();
  console.log(`\n🤔 用户: ${cliArg}\n`);
  console.log("🔍 Agent 正在检索和分析...\n");
  try {
    const answer = await agent.chat(cliArg, session.id);
    console.log(`📝 回答:\n\n${answer}`);
  } catch (err) {
    console.error("❌ 错误:", err);
    process.exit(1);
  }
  process.exit(0);
}

// 否则进入 REPL
repl();
