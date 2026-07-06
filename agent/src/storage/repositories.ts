import { getDb } from "./db";

export type TraceEventRow = {
  trace_id: string;
  event: string;
  payload_json: string;
  created_at: string;
};

export type CommandRunRow = {
  id: number;
  trace_id: string;
  chat_id: string;
  command_name: string;
  label: string;
  cwd: string;
  command: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  output_tail: string | null;
  error_message: string | null;
};

export type PendingConfirmationRow = {
  chat_id: string;
  trace_id: string;
  command_name: string;
  payload_json: string;
  expires_at: string;
  created_at: string;
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function setJsonState(table: "kv_state" | "runtime_state", key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO ${table} (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    )
    .run(key, JSON.stringify(value), nowIso());
}

export function getJsonState<T>(table: "kv_state" | "runtime_state", key: string): T | null {
  const row = getDb()
    .prepare(`SELECT value_json FROM ${table} WHERE key = ?`)
    .get(key) as { value_json: string } | undefined;
  return row ? (JSON.parse(row.value_json) as T) : null;
}

export function insertTraceEvent(traceId: string, event: string, payload: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO trace_events (trace_id, event, payload_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(traceId, event, JSON.stringify(payload ?? {}), nowIso());
}

export function listTraceEvents(traceId: string, limit = 50): TraceEventRow[] {
  return getDb()
    .prepare(
      `SELECT trace_id, event, payload_json, created_at
       FROM trace_events
       WHERE trace_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    )
    .all(traceId, limit) as TraceEventRow[];
}

export function getLastFailedToolEvent(): TraceEventRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT trace_id, event, payload_json, created_at
         FROM trace_events
         WHERE event = 'file.failed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get() as TraceEventRow | undefined) || null
  );
}

export function insertChatMessage(input: {
  chatId: string;
  userId: string;
  role: string;
  content: string;
  traceId: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO chat_messages (chat_id, user_id, role, content, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(input.chatId, input.userId, input.role, input.content, input.traceId, nowIso());
}

export function listRecentChat(chatId: string, limit = 20): Array<{
  chat_id: string;
  user_id: string;
  role: string;
  content: string;
  trace_id: string;
  created_at: string;
}> {
  return getDb()
    .prepare(
      `SELECT chat_id, user_id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(chatId, limit)
    .reverse() as Array<{
    chat_id: string;
    user_id: string;
    role: string;
    content: string;
    trace_id: string;
    created_at: string;
  }>;
}

export function insertCommandRun(input: {
  traceId: string;
  chatId: string;
  commandName: string;
  label: string;
  cwd: string;
  command: string;
  startedAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO command_runs
       (trace_id, chat_id, command_name, label, cwd, command, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(
      input.traceId,
      input.chatId,
      input.commandName,
      input.label,
      input.cwd,
      input.command,
      input.startedAt,
    );
}

export function finishCommandRun(input: {
  traceId: string;
  status: "success" | "failed";
  finishedAt: string;
  exitCode: number | null;
  outputTail: string;
  errorMessage?: string;
}): void {
  getDb()
    .prepare(
      `UPDATE command_runs
       SET status = ?, finished_at = ?, exit_code = ?, output_tail = ?, error_message = ?
       WHERE trace_id = ?`,
    )
    .run(
      input.status,
      input.finishedAt,
      input.exitCode,
      input.outputTail,
      input.errorMessage || null,
      input.traceId,
    );
}

export function getLastCommandRun(): CommandRunRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM command_runs ORDER BY started_at DESC, id DESC LIMIT 1`)
      .get() as CommandRunRow | undefined) || null
  );
}

export function getLastFailedCommandRun(): CommandRunRow | null {
  return (
    (getDb()
      .prepare(
        `SELECT * FROM command_runs
         WHERE status = 'failed'
         ORDER BY finished_at DESC, id DESC
         LIMIT 1`,
      )
      .get() as CommandRunRow | undefined) || null
  );
}

export function listRecentCommandRuns(chatId: string, limit = 3): CommandRunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM command_runs
       WHERE chat_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    )
    .all(chatId, limit) as CommandRunRow[];
}

export function upsertPendingConfirmation(input: {
  chatId: string;
  traceId: string;
  commandName: string;
  payload: unknown;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO pending_confirmations
       (chat_id, trace_id, command_name, payload_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         trace_id = excluded.trace_id,
         command_name = excluded.command_name,
         payload_json = excluded.payload_json,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`,
    )
    .run(
      input.chatId,
      input.traceId,
      input.commandName,
      JSON.stringify(input.payload),
      input.expiresAt,
      nowIso(),
    );
}

export function getPendingConfirmation(chatId: string): PendingConfirmationRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM pending_confirmations WHERE chat_id = ?`)
      .get(chatId) as PendingConfirmationRow | undefined) || null
  );
}

export function deletePendingConfirmation(chatId: string): void {
  getDb().prepare(`DELETE FROM pending_confirmations WHERE chat_id = ?`).run(chatId);
}

export function countPendingConfirmations(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM pending_confirmations WHERE expires_at > ?`)
    .get(nowIso()) as { count: number };
  return row.count;
}
