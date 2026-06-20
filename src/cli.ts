import { config } from "./core/config";
import { createAgent } from "./core/create-agent";

// ========== 初始化 ==========
const agent = createAgent();

// ========== 进度展示 ==========
agent.onProgress = (event) => {
  switch (event.type) {
    case "thinking":
      console.log(`💭 ${event.message}`);
      break;

    case "token":
      process.stdout.write(event.message);
      break;

    case "tool_call": {
      const toolName = event.tool?.name || event.message;
      const args = event.tool?.args || {};
      const queryStr = String(args.query || args.path || "");
      console.log(`\n🔧 ${toolName}  "${queryStr.slice(0, 80)}${queryStr.length > 80 ? "..." : ""}"`);
      break;
    }

    case "tool_result": {
      const toolName = event.tool?.name || "?";
      const ms = event.ms || 0;
      const preview = event.message;
      const lines = preview.split("\\n").slice(0, 5);
      console.log(`\n\n📥 ${toolName} 结果 (${ms}ms):`);
      for (const line of lines) {
        console.log(`   ${line.slice(0, 120)}`);
      }
      if (event.message.length > 200) {
        console.log(`   ... (共 ${event.result?.fullLength || event.message.length} 字符)`);
      }
      console.log(); // 空行分隔
      break;
    }

    case "done":
      console.log(`✅ ${event.message}\n`);
      break;
  }
};

// ========== 帮助 ==========
function showHelp() {
  console.log(`
  高考志愿 Agent — 命令列表
  ──────────────────────────
  /new <问题>      创建新会话并提问（也可直接输入问题，自动创建）
  /sessions        列出所有会话（带编号）
  /switch <编号|ID> 切换到指定会话
  /delete <编号|ID> 删除指定会话
  /help            显示本帮助
  /exit            退出

  直接输入文字即对当前会话提问（无会话时自动创建）
`);
}

// ========== 会话辅助 ==========

/** 获取带编号的会话列表 */
function getNumberedSessions() {
  return agent.sessionRepo.list().map((s, i) => ({ index: i + 1, ...s }));
}

/** 根据编号或ID查找会话 */
function resolveSession(arg: string) {
  if (/^\d+$/.test(arg)) {
    const idx = parseInt(arg, 10);
    const sessions = agent.sessionRepo.list();
    return sessions[idx - 1] || null;
  }
  return agent.sessionRepo.get(arg);
}

// ========== REPL ==========
async function repl() {
  console.log("\n🎓 高考志愿 Agent — 张雪峰风格\n");

  // 启动时显示最近会话
  const recentSessions = agent.sessionRepo.list(5);
  if (recentSessions.length > 0) {
    console.log("最近会话:");
    for (let i = 0; i < recentSessions.length; i++) {
      const s = recentSessions[i]!;
      console.log(`  ${i + 1}. ${s.id} — ${s.title || "(无标题)"} — ${s.message_count}轮`);
    }
    console.log("  输入 /switch <编号> 继续会话，或直接输入问题开始新会话\n");
  } else {
    console.log("直接输入问题即可开始，或输入 /help 查看命令\n");
  }

  let currentSessionId: string | null = null;

  const showPrompt = () => {
    if (currentSessionId) {
      const session = agent.sessionRepo.get(currentSessionId);
      const title = session?.title || currentSessionId;
      const count = session?.message_count || 0;
      process.stdout.write(`🎓 [${title.slice(0, 25)}](${count}轮) > `);
    } else {
      process.stdout.write("🎓 > ");
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
          agent.close();
          process.exit(0);

        case "/help":
          showHelp();
          break;

        case "/new": {
          if (!arg) {
            console.log("用法: /new <问题>");
            break;
          }
          const session = agent.sessionRepo.create();
          currentSessionId = session.id;
          console.log(`📝 新会话: ${session.id}`);
          console.log("🔍 Agent 正在检索和分析...\n");

          try {
            const answer = await agent.chat(arg, session.id);
            console.log(`${answer}\n`);
          } catch (err) {
            console.error("❌ 错误:", err);
          }
          break;
        }

        case "/sessions": {
          const sessions = agent.sessionRepo.list();
          if (sessions.length === 0) {
            console.log("暂无历史会话");
          } else {
            console.log("\n📋 历史会话:\n");
            for (let i = 0; i < sessions.length; i++) {
              const s = sessions[i]!;
              const marker = s.id === currentSessionId ? "*" : " ";
              console.log(
                ` ${marker}${i + 1}. ${s.id} — ${s.title || "(无标题)"} — ${s.message_count}轮 — ${s.updated_at}`,
              );
            }
            console.log(`\n  共 ${sessions.length} 个会话，/switch <编号> 切换，/delete <编号> 删除\n`);
          }
          break;
        }

        case "/switch": {
          if (!arg) {
            console.log("用法: /switch <编号|会话ID>");
            break;
          }
          const session = resolveSession(arg);
          if (!session) {
            console.log(`会话 "${arg}" 不存在，输入 /sessions 查看列表`);
          } else {
            currentSessionId = session.id;
            console.log(`已切换到: ${session.title || session.id} (${session.message_count}轮历史)`);
          }
          break;
        }

        case "/delete": {
          if (!arg) {
            console.log("用法: /delete <编号|会话ID>");
            break;
          }
          const session = resolveSession(arg);
          if (!session) {
            console.log(`会话 "${arg}" 不存在，输入 /sessions 查看列表`);
          } else {
            const wasCurrent = session.id === currentSessionId;
            agent.sessionRepo.delete(session.id);
            console.log(`已删除会话: ${session.title || session.id}`);
            if (wasCurrent) {
              currentSessionId = null;
              console.log("当前会话已删除，请选择或创建新会话");
            }
          }
          break;
        }

        default:
          console.log(`未知命令: ${cmd}，输入 /help 查看帮助`);
      }
      showPrompt();
      continue;
    }

    // ----- 普通提问 -----

    if (!config.llmApiKey) {
      console.log("❌ 请先设置 LLM_API_KEY 环境变量");
      showPrompt();
      continue;
    }

    // 无当前会话 → 自动创建
    if (!currentSessionId) {
      const session = agent.sessionRepo.create();
      currentSessionId = session.id;
      console.log(`📝 自动创建会话: ${session.id}`);
    }

    console.log("🔍 Agent 开始工作...\n");
    try {
      const answer = await agent.chat(input, currentSessionId);
      console.log(`${answer}\n`);
    } catch (err) {
      console.error("❌ 错误:", err);
    }

    showPrompt();
  }
}

// 如果传了命令行参数，走单次模式
const cliArg = process.argv[2];
if (cliArg && !cliArg.startsWith("/")) {
  const session = agent.sessionRepo.create();
  console.log(`\n🤔 用户: ${cliArg}\n`);
  console.log("🔍 Agent 正在检索和分析...\n");
  try {
    const answer = await agent.chat(cliArg, session.id);
    console.log(`📝 回答:\n\n${answer}`);
  } catch (err) {
    console.error("❌ 错误:", err);
    agent.close();
    process.exit(1);
  }
  agent.close();
  process.exit(0);
}

// 否则进入 REPL
repl();
