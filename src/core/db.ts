import { Database } from "bun:sqlite";
import * as path from "node:path";

let db: Database;

export function getDb(storagePath = "./data/agent.db"): Database {
  if (db) return db;
  const dir = path.dirname(storagePath);
  // bun:sqlite doesn't have mkdir, so we use Bun's fs API indirectly
  // Actually Bun handles this natively - let's just ensure the directory exists
  const { mkdirSync } = require("node:fs");
  mkdirSync(dir, { recursive: true });

  db = new Database(storagePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initTables(db);
  return db;
}

function initTables(db: Database) {
  // 原型阶段：重建 memories 表为 session 隔离版
  db.exec("DROP TABLE IF EXISTS memories");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      title       TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      role        TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT '',
      tool_calls  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL DEFAULT 'global',
      key         TEXT NOT NULL,
      value       TEXT NOT NULL,
      category    TEXT DEFAULT 'fact',
      updated_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(session_id, key)
    );
  `);
}
