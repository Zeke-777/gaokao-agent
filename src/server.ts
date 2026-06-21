import { config } from "./core/config";
import { createAgent } from "./core/create-agent";
import { createSSEStream } from "./sse-handler";

// ====== 初始化 ======
const agent = createAgent();
const DIST = "./src/web/dist";

// ====== 静态文件服务 ======
async function serveStatic(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return new Response(file);
}

// ====== CORS ======
function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors() },
  });
}

// ====== HTTP 服务 ======
Bun.serve({
  port: config.port,
  idleTimeout: 120,
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
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...cors(),
        },
      });
    }

    // GET/POST /api/sessions
    if (path === "/api/sessions" && req.method === "GET") return json(agent.sessionRepo.list());
    if (path === "/api/sessions" && req.method === "POST") return json(agent.sessionRepo.create());

    // GET/DELETE /api/sessions/:id
    const sessMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessMatch) {
      const sid = sessMatch[1]!;
      if (req.method === "GET") {
        const s = agent.sessionRepo.get(sid);
        if (!s) return json({ error: "not found" }, 404);
        const history = agent.messageRepo.loadHistory(sid).map((m) => ({
          role: m.role,
          content: m.content,
          tool_events: m.tool_events ? (() => { try { return JSON.parse(m.tool_events); } catch { return undefined; } })() : undefined,
        }));
        return json({ ...s, messages: history });
      }
      if (req.method === "DELETE") {
        agent.sessionRepo.delete(sid);
        return json({ ok: true });
      }
      if (req.method === "PATCH") {
        if (!agent.sessionRepo.get(sid)) return json({ error: "not found" }, 404);
        const { title } = (await req.json().catch(() => ({}))) as { title?: string };
        if (!title) return json({ error: "title required" }, 400);
        agent.sessionRepo.setTitle(sid, title);
        return json({ ok: true });
      }
    }

    // GET /api/health
    if (path === "/api/health") return json({ status: "ok", model: config.llmModel });

    // ====== 静态前端 ======
    // 首页
    if (path === "/" || path === "/index.html") {
      const resp = await serveStatic(`${DIST}/landing.html`);
      if (resp) return resp;
      return new Response("landing.html not found — run: bun run build", { status: 404 });
    }

    // SPA (/app → dist/index.html, /app/xxx → dist/xxx, fallback to index.html)
    if (path.startsWith("/app")) {
      const assetPath = path === "/app" ? "/index.html" : path.slice(4);
      const resp = await serveStatic(`${DIST}${assetPath}`);
      if (resp) return resp;
      // SPA fallback: 前端路由（如 /app/settings）回退到 index.html
      const fallback = await serveStatic(`${DIST}/index.html`);
      if (fallback) return fallback;
      return new Response("app not found — run: bun run build", { status: 404 });
    }

    // 其他静态文件兜底
    const staticResp = await serveStatic(`${DIST}${path}`);
    if (staticResp) return staticResp;

    return json({ error: "not found" }, 404);
  },
});

console.log(`🚀 高考志愿Agent API: http://127.0.0.1:${config.port}`);

// 优雅关闭
process.on("SIGINT", () => {
  console.log("\n正在关闭...");
  agent.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n正在关闭...");
  agent.close();
  process.exit(0);
});
