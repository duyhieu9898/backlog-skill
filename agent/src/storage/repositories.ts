import { randomUUID } from "node:crypto";
import { getDb } from "./db";

export type TraceEventRow = {
  trace_id: string;
  event: string;
  payload_json: string;
  created_at: string;
};

export type ArtifactRow = {
  id: string;
  owner_chat_id: string;
  source_trace_id: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  local_path: string;
  expires_at: string;
  delivered_at: string | null;
  created_at: string;
};

export function insertArtifact(row: ArtifactRow): void {
  getDb().prepare(`INSERT INTO artifacts (id, owner_chat_id, source_trace_id, mime_type, byte_size, sha256, local_path, expires_at, delivered_at, created_at) VALUES (@id, @owner_chat_id, @source_trace_id, @mime_type, @byte_size, @sha256, @local_path, @expires_at, @delivered_at, @created_at)`).run(row);
}

export function getArtifact(id: string): ArtifactRow | null {
  return (getDb().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) as ArtifactRow | undefined) || null;
}

export function markArtifactDelivered(id: string): void {
  getDb().prepare(`UPDATE artifacts SET delivered_at = ? WHERE id = ?`).run(nowIso(), id);
}

export function deleteArtifact(id: string): void {
  getDb().prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
}

export function listExpiredArtifacts(now = nowIso()): ArtifactRow[] {
  return getDb().prepare(`SELECT * FROM artifacts WHERE expires_at <= ?`).all(now) as ArtifactRow[];
}

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

export type ScheduledJobRow = {
  name: string;
  label: string;
  command_name: string;
  interval_minutes: number;
  daily_at: string | null;
  cron_expr: string | null;
  enabled: number;
  delivery: string;
  notify_on_change_only: number;
  prepare_effect_json: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_trace_id: string | null;
  last_output_digest: string | null;
  version: number;
  lease_owner: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
};

export type ScheduledRunRow = {
  id: number;
  job_name: string;
  trace_id: string;
  status: string;
  exit_code: number;
  output_tail: string;
  output_digest: string;
  notification_sent: number;
  started_at: string;
  finished_at: string;
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

export function getActiveSessionId(chatId: string): string {
  const key = `active_session:${chatId}`;
  const sessionId = getJsonState<string>("runtime_state", key);
  return sessionId || "default";
}

export function resetSession(chatId: string): string {
  const key = `active_session:${chatId}`;
  const sessionId = randomUUID();
  setJsonState("runtime_state", key, sessionId);
  return sessionId;
}

export function insertChatMessage(input: {
  chatId: string;
  userId: string;
  role: string;
  content: string;
  traceId: string;
  sessionId?: string;
}): void {
  const sessionId = input.sessionId || getActiveSessionId(input.chatId);
  getDb()
    .prepare(
      `INSERT INTO chat_messages (chat_id, session_id, user_id, role, content, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.chatId, sessionId, input.userId, input.role, input.content, input.traceId, nowIso());
}

export function listRecentChat(chatId: string, limit = 20): Array<{
  chat_id: string;
  user_id: string;
  role: string;
  content: string;
  trace_id: string;
  created_at: string;
}> {
  const sessionId = getActiveSessionId(chatId);
  const isDefault = sessionId === "default";
  const sql = isDefault
    ? `SELECT chat_id, user_id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ? AND (session_id = 'default' OR session_id IS NULL)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    : `SELECT chat_id, user_id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ? AND session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`;

  const stmt = getDb().prepare(sql);
  const rows = isDefault ? stmt.all(chatId, limit) : stmt.all(chatId, sessionId, limit);

  return rows.reverse() as Array<{
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

export function upsertScheduledJob(input: {
  name: string;
  label: string;
  commandName: string;
  cronExpr: string;
  enabled: boolean;
  delivery: string;
  notifyOnChangeOnly: boolean;
  prepareEffect?: unknown;
  nextRunAt?: string | null;
}): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO scheduled_jobs
       (name, label, command_name, interval_minutes, daily_at, cron_expr, enabled, delivery,
        notify_on_change_only, prepare_effect_json, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         label = excluded.label,
         command_name = excluded.command_name,
         cron_expr = excluded.cron_expr,
         prepare_effect_json = excluded.prepare_effect_json,
         next_run_at = CASE
           WHEN scheduled_jobs.enabled = 0
             THEN NULL
           WHEN scheduled_jobs.cron_expr IS NOT excluded.cron_expr
             THEN excluded.next_run_at
           ELSE scheduled_jobs.next_run_at
         END,
         version = scheduled_jobs.version + 1,
         updated_at = excluded.updated_at
       WHERE scheduled_jobs.label IS NOT excluded.label
          OR scheduled_jobs.command_name IS NOT excluded.command_name
          OR scheduled_jobs.cron_expr IS NOT excluded.cron_expr
          OR scheduled_jobs.prepare_effect_json IS NOT excluded.prepare_effect_json`,
    )
    .run(
      input.name,
      input.label,
      input.commandName,
      input.cronExpr,
      input.enabled ? 1 : 0,
      input.delivery,
      input.notifyOnChangeOnly ? 1 : 0,
      input.prepareEffect === undefined ? null : JSON.stringify(input.prepareEffect),
      input.nextRunAt ?? null,
      now,
      now,
    );
}

export function listScheduledJobs(): ScheduledJobRow[] {
  return getDb()
    .prepare(`SELECT * FROM scheduled_jobs ORDER BY name ASC`)
    .all() as ScheduledJobRow[];
}

export function getScheduledJob(name: string): ScheduledJobRow | null {
  return (
    (getDb()
      .prepare(`SELECT * FROM scheduled_jobs WHERE name = ?`)
      .get(name) as ScheduledJobRow | undefined) || null
  );
}

export function listDueScheduledJobs(now = nowIso()): ScheduledJobRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_jobs
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC, name ASC`,
    )
    .all(now) as ScheduledJobRow[];
}

export function claimDueScheduledJob(input: {
  name: string;
  leaseOwner: string;
  leaseUntil: string;
  now?: string;
}): ScheduledJobRow | null {
  const now = input.now || nowIso();
  const db = getDb();
  const transaction = db.transaction(() => {
    const current = db
      .prepare(`SELECT * FROM scheduled_jobs WHERE name = ?`)
      .get(input.name) as ScheduledJobRow | undefined;
    if (
      !current ||
      current.enabled !== 1 ||
      !current.next_run_at ||
      current.next_run_at > now ||
      (current.lease_until && current.lease_until > now)
    ) {
      return null;
    }
    const result = db
      .prepare(
        `UPDATE scheduled_jobs
         SET lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE name = ?
           AND enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
           AND (lease_until IS NULL OR lease_until <= ?)`,
      )
      .run(input.leaseOwner, input.leaseUntil, now, input.name, now, now);
    if (result.changes !== 1) return null;
    return db.prepare(`SELECT * FROM scheduled_jobs WHERE name = ?`).get(input.name) as ScheduledJobRow;
  });
  return transaction();
}

export function updateScheduledJobState(input: {
  name: string;
  enabled?: boolean;
  cronExpr?: string | null;
  delivery?: string;
  nextRunAt?: string | null;
  expectedVersion?: number;
}): ScheduledJobRow {
  const current = getScheduledJob(input.name);
  if (!current) throw new Error(`Scheduled job not found: ${input.name}`);
  if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
    throw new Error(`Scheduled job changed. Expected version ${input.expectedVersion}, got ${current.version}.`);
  }
  const result = getDb()
    .prepare(
      `UPDATE scheduled_jobs
       SET enabled = ?, cron_expr = ?, delivery = ?, next_run_at = ?,
           version = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE name = ?`,
    )
    .run(
      input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0,
      input.cronExpr === undefined ? current.cron_expr : input.cronExpr,
      input.delivery ?? current.delivery,
      input.nextRunAt === undefined ? current.next_run_at : input.nextRunAt,
      current.version + 1,
      nowIso(),
      input.name,
    );
  if (result.changes !== 1) throw new Error(`Scheduled job update failed: ${input.name}`);
  return getScheduledJob(input.name)!;
}

export function recordScheduledRun(input: {
  jobName: string;
  leaseOwner?: string;
  traceId: string;
  status: "success" | "failed";
  exitCode: number;
  outputTail: string;
  outputDigest: string;
  notificationSent: boolean;
  startedAt: string;
  finishedAt: string;
  nextRunAt: string | null;
}): void {
  const db = getDb();
  const transaction = db.transaction(() => {
    db.prepare(
      `INSERT INTO scheduled_runs
       (job_name, trace_id, status, exit_code, output_tail, output_digest,
        notification_sent, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.jobName,
      input.traceId,
      input.status,
      input.exitCode,
      input.outputTail,
      input.outputDigest,
      input.notificationSent ? 1 : 0,
      input.startedAt,
      input.finishedAt,
    );
    db.prepare(
      `UPDATE scheduled_jobs
       SET next_run_at = ?, last_run_at = ?, last_status = ?, last_trace_id = ?,
           last_output_digest = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE name = ? AND (? IS NULL OR lease_owner = ?)`,
    ).run(
      input.nextRunAt,
      input.finishedAt,
      input.status,
      input.traceId,
      input.outputDigest,
      nowIso(),
      input.jobName,
      input.leaseOwner || null,
      input.leaseOwner || null,
    );
  });
  transaction();
}

export function listScheduledRuns(jobName: string, limit = 5): ScheduledRunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_runs
       WHERE job_name = ?
       ORDER BY finished_at DESC, id DESC
       LIMIT ?`,
    )
    .all(jobName, limit) as ScheduledRunRow[];
}

export function clearChatHistory(chatId: string): void {
  getDb().prepare(`DELETE FROM chat_messages WHERE chat_id = ?`).run(chatId);
}

