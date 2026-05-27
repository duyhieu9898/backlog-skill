import fs from "node:fs";

import Database from "better-sqlite3";

import { dataDir, sqliteFile } from "../config/paths";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(sqliteFile);
    db.pragma("journal_mode = WAL");
    initializeSchema(db);
  }

  return db;
}

export function initializeSchema(database = getDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kv_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_created
      ON chat_messages(chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trace_events_trace_created
      ON trace_events(trace_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS command_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      exit_code INTEGER,
      output_tail TEXT,
      error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_command_runs_started
      ON command_runs(started_at DESC);

    CREATE TABLE IF NOT EXISTS pending_confirmations (
      chat_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      command_name TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_state (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

export function closeDb(): void {
  db?.close();
  db = null;
}
