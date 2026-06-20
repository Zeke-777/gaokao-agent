import { Database } from "bun:sqlite";
import * as path from "node:path";
import { mkdirSync } from "node:fs";

let db: Database;

export function getDb(storagePath = "./data/agent.db"): Database {
  if (db) return db;
  const dir = path.dirname(storagePath);
  mkdirSync(dir, { recursive: true });

  db = new Database(storagePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

/** 统一 schema 初始化：建表 + 索引 + 迁移 */
function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      tool_calls  TEXT,
      tool_events TEXT,
      tool_call_id TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at);
  `);
  // 迁移：旧库可能缺少 tool_events 列
  try { db.exec("ALTER TABLE messages ADD COLUMN tool_events TEXT"); } catch {}
  // 迁移：旧库可能缺少 tool_call_id 列
  try { db.exec("ALTER TABLE messages ADD COLUMN tool_call_id TEXT"); } catch {}
  // 迁移：旧库 messages 表可能缺少 ON DELETE CASCADE（SQLite 不支持 ALTER TABLE 加 FK 约束）
  migrateCascade(db);
}

/** 检查 messages 表的 FK 是否有 ON DELETE CASCADE，没有则重建表 */
function migrateCascade(db: Database) {
  const fkList = db.prepare("PRAGMA foreign_key_list(messages)").all() as Array<{ table: string; on_delete: string }>;
  const hasCascade = fkList.some((fk) => fk.table === "sessions" && fk.on_delete.toUpperCase() === "CASCADE");
  if (hasCascade) return;

  // 旧库没有 CASCADE → 在事务中重建表，防止崩溃丢数据
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE messages_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,
        content     TEXT NOT NULL DEFAULT '',
        tool_calls  TEXT,
        tool_events TEXT,
        tool_call_id TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO messages_new (id, session_id, role, content, tool_calls, tool_events, tool_call_id, created_at)
        SELECT id, session_id, role, content, tool_calls, tool_events, tool_call_id, created_at FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_new RENAME TO messages;
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    `);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
