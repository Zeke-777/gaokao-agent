import { getDb } from "./db";

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  created_at: string;
}

function db() {
  return getDb();
}

/** 创建新会话 */
export function createSession(title = ""): Session {
  const now = new Date();
  const ts =
    `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}` +
    `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const id = `${ts}-${crypto.randomUUID().slice(0, 4)}`;
  db()
    .prepare("INSERT INTO sessions (id, title) VALUES (?, ?)")
    .run(id, title);
  return { id, title, created_at: "", updated_at: "", message_count: 0 };
}

/** 列出所有会话（按最近更新排序） */
export function listSessions(limit = 20): Session[] {
  const stmt = db().prepare(
    `SELECT s.*, COUNT(m.id) as message_count
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE m.role IN ('user', 'assistant')
     GROUP BY s.id
     ORDER BY s.updated_at DESC
     LIMIT ?`,
  );
  return stmt.all(limit) as Session[];
}

/** 获取单个会话 */
export function getSession(sessionId: string): Session | null {
  const stmt = db().prepare(
    `SELECT s.*, COUNT(m.id) as message_count
     FROM sessions s
     LEFT JOIN messages m ON m.session_id = s.id
     WHERE m.role IN ('user', 'assistant') AND s.id = ?
     GROUP BY s.id`,
  );
  return (stmt.get(sessionId) as Session) || null;
}

/** 保存消息到会话 */
export function saveMessage(
  sessionId: string,
  role: string,
  content: string,
  toolCalls?: unknown,
) {
  db()
    .prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?, ?, ?, ?)",
    )
    .run(sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null);

  db()
    .prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?")
    .run(sessionId);

  // 自动设置标题
  const session = getSession(sessionId);
  if (session && !session.title) {
    const stmt = db().prepare(
      "SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1",
    );
    const row = stmt.get(sessionId) as { content: string } | undefined;
    if (row) {
      const title = row.content.slice(0, 60);
      db()
        .prepare("UPDATE sessions SET title = ? WHERE id = ?")
        .run(title, sessionId);
    }
  }
}

/** 加载会话完整消息（含 tool 调用） */
export function loadFullHistory(sessionId: string): MessageRow[] {
  const stmt = db().prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY id",
  );
  return stmt.all(sessionId) as MessageRow[];
}

/** 更新会话标题 */
export function updateSessionTitle(sessionId: string, title: string) {
  db()
    .prepare(
      "UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .run(title, sessionId);
}
