import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { loadAgentConfig } from "../config/app";

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

export type PendingApprovalRow = {
  id: string;
  short_id: string;
  run_id: string;
  principal_id: string;
  chat_id: string;
  description: string;
  action_digest: string;
  payload_json: string;
  status: "pending" | "approved" | "rejected" | "expired" | "invalidated";
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
};

export type RunRow = {
  id: string;
  session_id: string;
  principal_id: string;
  channel: string;
  user_request: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  trace_id: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type ContextCheckpointRow = {
  chat_id: string;
  session_id: string;
  checkpoint_json: string;
  first_kept_message_id: number | null;
  tokens_before: number;
  compaction_count: number;
  created_at: string;
  updated_at: string;
};

export type ApprovalGrantRow = {
  id: string;
  principal_id: string;
  description: string;
  scope: "run" | "session" | "schedule" | "persistent";
  run_id: string | null;
  session_id: string | null;
  schedule_id: string | null;
  risk_categories_json: string | null;
  resource_hints_json: string | null;
  command_hints_json: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

export type RunStepRow = {
  id: number;
  run_id: string;
  ordinal: number;
  tool_name: string;
  call_json: string;
  result_json: string;
  created_at: string;
};

export type ScheduledJobRow = {
  name: string;
  source: "config" | "runtime";
  label: string;
  command_name: string;
  interval_minutes: number;
  daily_at: string | null;
  cron_expr: string | null;
  timezone: string;
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
  // Prune old trace_events on a throttle so the table cannot grow unbounded in a
  // long-running process (raw-AI JSONL already prunes; trace_events did not).
  const now = Date.now();
  if (now - tracePruneAt > TRACE_PRUNE_INTERVAL_MS) {
    tracePruneAt = now;
    pruneTraceEvents(loadAgentConfig().logging?.traceRetentionDays ?? 30);
  }
}

/** Best-effort: a retention < 1 day is treated as "do not prune". */
export function pruneTraceEvents(retentionDays: number): number {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) return 0;
  const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  return getDb().prepare(`DELETE FROM trace_events WHERE created_at < ?`).run(cutoffIso).changes;
}

const TRACE_PRUNE_INTERVAL_MS = 60_000;
let tracePruneAt = 0;

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

export function createRun(input: Omit<RunRow, "status" | "error" | "created_at" | "updated_at" | "completed_at">): void {
  const now = nowIso();
  getDb().prepare(
    `INSERT INTO runs (id, session_id, principal_id, channel, user_request, status, trace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(input.id, input.session_id, input.principal_id, input.channel, input.user_request, input.trace_id, now, now);
}

export function finishRun(id: string, status: Extract<RunRow["status"], "completed" | "failed" | "cancelled">, error?: string): void {
  const now = nowIso();
  getDb().prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(status, error || null, now, now, id);
}

export function setRunStatus(id: string, status: Extract<RunRow["status"], "running" | "waiting_approval">): void {
  getDb().prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
}

export function getRun(id: string): RunRow | null {
  return (getDb().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined) || null;
}

export function appendRunStep(input: { runId: string; toolName: string; call: unknown; result: unknown }): void {
  const db = getDb();
  const insert = db.transaction(() => {
    const row = db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM run_steps WHERE run_id = ?`).get(input.runId) as { ordinal: number };
    db.prepare(
      `INSERT INTO run_steps (run_id, ordinal, tool_name, call_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.runId, row.ordinal + 1, input.toolName, JSON.stringify(input.call), JSON.stringify(input.result), nowIso());
  });
  insert();
}

export function listRunSteps(runId: string): RunStepRow[] {
  return getDb().prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY ordinal ASC`).all(runId) as RunStepRow[];
}

export function listSessionToolContextBlocks(chatId: string): Array<{ trace_id: string; created_at: string; call_json: string; result_json: string }> {
  const sessionId = getActiveSessionId(chatId);
  const sessionClause = sessionId === "default"
    ? "(cm.session_id = 'default' OR cm.session_id IS NULL)"
    : "cm.session_id = ?";
  const sql = `SELECT rs.run_id AS trace_id, rs.created_at, rs.call_json, rs.result_json
    FROM run_steps rs
    WHERE EXISTS (
      SELECT 1 FROM chat_messages cm
      WHERE cm.chat_id = ? AND ${sessionClause} AND cm.trace_id = rs.run_id
    )
    ORDER BY rs.created_at ASC, rs.id ASC`;
  return (sessionId === "default"
    ? getDb().prepare(sql).all(chatId)
    : getDb().prepare(sql).all(chatId, sessionId)) as Array<{ trace_id: string; created_at: string; call_json: string; result_json: string }>;
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
  createdAt?: string;
}): void {
  const sessionId = input.sessionId || getActiveSessionId(input.chatId);
  const createdAt = input.createdAt || nowIso();
  getDb()
    .prepare(
      `INSERT INTO chat_messages (chat_id, session_id, user_id, role, content, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.chatId, sessionId, input.userId, input.role, input.content, input.traceId, createdAt);
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

export function listActiveSessionChat(chatId: string): Array<{
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
       ORDER BY created_at ASC, id ASC`
    : `SELECT chat_id, user_id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ? AND session_id = ?
       ORDER BY created_at ASC, id ASC`;
  return (isDefault ? getDb().prepare(sql).all(chatId) : getDb().prepare(sql).all(chatId, sessionId)) as Array<{
    chat_id: string; user_id: string; role: string; content: string; trace_id: string; created_at: string;
  }>;
}

export function getContextCheckpoint(chatId: string, sessionId = getActiveSessionId(chatId)): ContextCheckpointRow | null {
  return (getDb().prepare(
    `SELECT * FROM context_checkpoints WHERE chat_id = ? AND session_id = ?`,
  ).get(chatId, sessionId) as ContextCheckpointRow | undefined) || null;
}

export function saveContextCheckpoint(input: {
  chatId: string;
  sessionId: string;
  checkpoint: unknown;
  firstKeptMessageId: number | null;
  tokensBefore: number;
}): ContextCheckpointRow {
  const existing = getContextCheckpoint(input.chatId, input.sessionId);
  const now = nowIso();
  const compactionCount = (existing?.compaction_count || 0) + 1;
  getDb().prepare(
    `INSERT INTO context_checkpoints
       (chat_id, session_id, checkpoint_json, first_kept_message_id, tokens_before, compaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, session_id) DO UPDATE SET
       checkpoint_json = excluded.checkpoint_json,
       first_kept_message_id = excluded.first_kept_message_id,
       tokens_before = excluded.tokens_before,
       compaction_count = excluded.compaction_count,
       updated_at = excluded.updated_at`,
  ).run(input.chatId, input.sessionId, JSON.stringify(input.checkpoint), input.firstKeptMessageId, input.tokensBefore, compactionCount, existing?.created_at || now, now);
  return getContextCheckpoint(input.chatId, input.sessionId)!;
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

export function createPendingApproval(input: Omit<PendingApprovalRow, "status" | "created_at" | "resolved_at">): void {
  getDb().prepare(
    `INSERT INTO pending_approvals
     (id, short_id, run_id, principal_id, chat_id, description, action_digest, payload_json, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(input.id, input.short_id, input.run_id, input.principal_id, input.chat_id, input.description, input.action_digest, input.payload_json, input.expires_at, nowIso());
}

export function getPendingApproval(shortId: string, principalId: string, chatId: string): PendingApprovalRow | null {
  return (getDb().prepare(
    `SELECT * FROM pending_approvals WHERE short_id = ? AND principal_id = ? AND chat_id = ?`,
  ).get(shortId, principalId, chatId) as PendingApprovalRow | undefined) || null;
}

export function listPendingApprovalsByChat(chatId: string, principalId?: string): PendingApprovalRow[] {
  const db = getDb();
  if (principalId) {
    return db.prepare(
      `SELECT * FROM pending_approvals WHERE chat_id = ? AND principal_id = ? AND status = 'pending'`,
    ).all(chatId, principalId) as PendingApprovalRow[];
  }
  return db.prepare(
    `SELECT * FROM pending_approvals WHERE chat_id = ? AND status = 'pending'`,
  ).all(chatId) as PendingApprovalRow[];
}

export function countPendingApprovals(): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS count FROM pending_approvals WHERE status = 'pending' AND expires_at > ?`)
    .get(nowIso()) as { count: number };
  return row.count;
}

export function resolvePendingApproval(id: string, status: Extract<PendingApprovalRow["status"], "approved" | "rejected" | "expired" | "invalidated">): void {
  getDb().prepare(`UPDATE pending_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`).run(status, nowIso(), id);
}

export function createApprovalGrant(input: {
  id: string;
  principalId: string;
  description: string;
  scope: ApprovalGrantRow["scope"];
  runId?: string;
  sessionId?: string;
  scheduleId?: string;
  riskCategories?: string[];
  resourceHints?: string[];
  commandHints?: string[];
  expiresAt?: string;
}): void {
  getDb().prepare(
    `INSERT INTO approval_grants
       (id, principal_id, description, scope, run_id, session_id, schedule_id,
        risk_categories_json, resource_hints_json, command_hints_json,
        created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.id,
    input.principalId,
    input.description,
    input.scope,
    input.runId || null,
    input.sessionId || null,
    input.scheduleId || null,
    input.riskCategories ? JSON.stringify(input.riskCategories) : null,
    input.resourceHints ? JSON.stringify(input.resourceHints) : null,
    input.commandHints ? JSON.stringify(input.commandHints) : null,
    nowIso(),
    input.expiresAt || null,
  );
}

export function listActiveApprovalGrants(input: {
  principalId: string;
  runId?: string;
  sessionId?: string;
  scheduleId?: string;
}): ApprovalGrantRow[] {
  const now = nowIso();
  return getDb().prepare(
    `SELECT * FROM approval_grants
     WHERE principal_id = ?
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND (
         (scope = 'run' AND run_id = ?)
         OR (scope = 'session' AND session_id = ?)
         OR (scope = 'schedule' AND schedule_id = ?)
         OR scope = 'persistent'
       )
     ORDER BY created_at DESC`,
  ).all(input.principalId, now, input.runId || null, input.sessionId || null, input.scheduleId || null) as ApprovalGrantRow[];
}

export function revokeApprovalGrant(id: string): void {
  getDb().prepare(`UPDATE approval_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), id);
}

export function upsertScheduledJob(input: {
  name: string;
  source?: "config" | "runtime";
  label: string;
  commandName: string;
  cronExpr: string;
  enabled: boolean;
  delivery: string;
  notifyOnChangeOnly: boolean;
  prepareEffect?: unknown;
  timezone?: string;
  nextRunAt?: string | null;
}): void {
  const now = nowIso();
  getDb()
    .prepare(
      `INSERT INTO scheduled_jobs
       (name, source, label, command_name, interval_minutes, daily_at, cron_expr, timezone, enabled, delivery,
        notify_on_change_only, prepare_effect_json, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         label = excluded.label,
         command_name = excluded.command_name,
         cron_expr = excluded.cron_expr,
         timezone = excluded.timezone,
         enabled = excluded.enabled,
         delivery = excluded.delivery,
         notify_on_change_only = excluded.notify_on_change_only,
         prepare_effect_json = excluded.prepare_effect_json,
         next_run_at = CASE
           WHEN excluded.enabled = 0
             THEN NULL
           WHEN scheduled_jobs.cron_expr IS NOT excluded.cron_expr
             OR scheduled_jobs.timezone IS NOT excluded.timezone
             OR scheduled_jobs.enabled IS NOT excluded.enabled
             THEN excluded.next_run_at
           ELSE scheduled_jobs.next_run_at
         END,
         version = scheduled_jobs.version + 1,
         updated_at = excluded.updated_at
       WHERE scheduled_jobs.source = excluded.source
         AND (scheduled_jobs.label IS NOT excluded.label
          OR scheduled_jobs.command_name IS NOT excluded.command_name
          OR scheduled_jobs.cron_expr IS NOT excluded.cron_expr
          OR scheduled_jobs.timezone IS NOT excluded.timezone
          OR scheduled_jobs.enabled IS NOT excluded.enabled
          OR scheduled_jobs.delivery IS NOT excluded.delivery
          OR scheduled_jobs.notify_on_change_only IS NOT excluded.notify_on_change_only
          OR scheduled_jobs.prepare_effect_json IS NOT excluded.prepare_effect_json)`,
    )
    .run(
      input.name,
      input.source || "config",
      input.label,
      input.commandName,
      input.cronExpr,
      input.timezone || "UTC",
      input.enabled ? 1 : 0,
      input.delivery,
      input.notifyOnChangeOnly ? 1 : 0,
      input.prepareEffect === undefined ? null : JSON.stringify(input.prepareEffect),
      input.nextRunAt ?? null,
      now,
      now,
    );
}

/** Config is authoritative only for schedules it owns; runtime schedules are never touched. */
export function disableRemovedConfigScheduledJobs(activeNames: string[]): void {
  const now = nowIso();
  const db = getDb();
  const filter = activeNames.length > 0
    ? `AND name NOT IN (${activeNames.map(() => "?").join(", ")})`
    : "";
  db.prepare(
    `UPDATE scheduled_jobs
     SET enabled = 0, next_run_at = NULL, lease_owner = NULL, lease_until = NULL,
         version = version + 1, updated_at = ?
     WHERE source = 'config' AND enabled = 1 ${filter}`,
  ).run(now, ...activeNames);
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

/** Runtime schedules are owned by their creator, never by config seeding. */
export function deleteRuntimeScheduledJob(name: string): boolean {
  return getDb()
    .prepare(`DELETE FROM scheduled_jobs WHERE name = ? AND source = 'runtime'`)
    .run(name).changes === 1;
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

export function getUncompactedChatMessages(chatId: string, sessionId: string): Array<{
  id: number;
  role: string;
  content: string;
  trace_id: string;
  created_at: string;
}> {
  return getDb()
    .prepare(
      `SELECT id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ? AND session_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(chatId, sessionId) as Array<{ id: number; role: string; content: string; trace_id: string; created_at: string }>;
}

export function markMessagesAsCompacted(messageIds: number[], compactedSessionId: string): void {
  const db = getDb();
  const placeholders = messageIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE chat_messages
     SET session_id = ?
     WHERE id IN (${placeholders})`,
  ).run(compactedSessionId, ...messageIds);
}
