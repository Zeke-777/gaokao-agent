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
    return this.get(id)!;
  }

  list(limit = 20): Session[] {
    return getDb()
      .prepare(
        `SELECT s.*, COUNT(m.id) as message_count
         FROM sessions s
         LEFT JOIN messages m ON m.session_id = s.id AND m.role IN ('user', 'assistant')
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
         LEFT JOIN messages m ON m.session_id = s.id AND m.role IN ('user', 'assistant')
         WHERE s.id = ?
         GROUP BY s.id`
      )
      .get(id) as Session) || null;
  }

  delete(id: string): void {
    // ON DELETE CASCADE 自动删除关联消息
    getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
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

  /** 轻量查询：仅获取标题（不做 JOIN） */
  getTitle(id: string): string | null {
    const row = getDb()
      .prepare("SELECT title FROM sessions WHERE id = ?")
      .get(id) as { title: string } | undefined;
    return row?.title ?? null;
  }

  setTitle(id: string, title: string): void {
    getDb()
      .prepare("UPDATE sessions SET title = ? WHERE id = ?")
      .run(title.slice(0, 60), id);
  }
}
