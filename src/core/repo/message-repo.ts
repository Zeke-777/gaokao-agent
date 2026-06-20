import { getDb } from "../db";
import type { LLMMessage } from "../types";

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_events: string | null;
  tool_call_id: string | null;
  created_at: string;
}

export class MessageRepo {
  /** 事务内原子写入一轮对话的所有消息（user + assistant + tool） */
  saveExchange(sessionId: string, newMessages: LLMMessage[], toolEvents?: unknown[]): void {
    const db = getDb();
    try {
      db.exec("BEGIN");
      let lastAssistantId: number | null = null;

      for (const msg of newMessages) {
        if (msg.role === "system") continue;
        const result = db.prepare(
          "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)",
        ).run(
          sessionId,
          msg.role,
          msg.content || "",
          msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
          msg.tool_call_id || null,
        );
        if (msg.role === "assistant") {
          lastAssistantId = Number(result.lastInsertRowid);
        }
      }

      // tool_events（UI 展示用）保存在最后一条 assistant 消息上
      if (toolEvents?.length && lastAssistantId) {
        db.prepare("UPDATE messages SET tool_events = ? WHERE id = ?")
          .run(JSON.stringify(toolEvents), lastAssistantId);
      }

      db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?")
        .run(sessionId);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  loadHistory(sessionId: string): MessageRow[] {
    return getDb()
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id")
      .all(sessionId) as MessageRow[];
  }
}
