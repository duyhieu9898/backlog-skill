"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.insertArtifact = insertArtifact;
exports.getArtifact = getArtifact;
exports.getArtifactMetadata = getArtifactMetadata;
exports.getArtifactByHash = getArtifactByHash;
exports.markArtifactDelivered = markArtifactDelivered;
exports.deleteArtifact = deleteArtifact;
exports.listExpiredArtifacts = listExpiredArtifacts;
exports.nowIso = nowIso;
exports.setJsonState = setJsonState;
exports.getJsonState = getJsonState;
exports.insertTraceEvent = insertTraceEvent;
exports.pruneTraceEvents = pruneTraceEvents;
exports.listTraceEvents = listTraceEvents;
exports.getLastFailedToolEvent = getLastFailedToolEvent;
exports.getActiveSessionId = getActiveSessionId;
exports.createRun = createRun;
exports.finishRun = finishRun;
exports.setRunStatus = setRunStatus;
exports.getRun = getRun;
exports.appendRunStep = appendRunStep;
exports.listRunSteps = listRunSteps;
exports.listSessionToolContextBlocks = listSessionToolContextBlocks;
exports.resetSession = resetSession;
exports.insertChatMessage = insertChatMessage;
exports.listRecentChat = listRecentChat;
exports.listActiveSessionChat = listActiveSessionChat;
exports.getContextCheckpoint = getContextCheckpoint;
exports.saveContextCheckpoint = saveContextCheckpoint;
exports.insertCommandRun = insertCommandRun;
exports.finishCommandRun = finishCommandRun;
exports.getLastCommandRun = getLastCommandRun;
exports.getLastFailedCommandRun = getLastFailedCommandRun;
exports.listRecentCommandRuns = listRecentCommandRuns;
exports.createPendingApproval = createPendingApproval;
exports.getPendingApproval = getPendingApproval;
exports.listPendingApprovalsByChat = listPendingApprovalsByChat;
exports.countPendingApprovals = countPendingApprovals;
exports.resolvePendingApproval = resolvePendingApproval;
exports.createApprovalGrant = createApprovalGrant;
exports.listActiveApprovalGrants = listActiveApprovalGrants;
exports.revokeApprovalGrant = revokeApprovalGrant;
exports.upsertScheduledJob = upsertScheduledJob;
exports.disableRemovedConfigScheduledJobs = disableRemovedConfigScheduledJobs;
exports.listScheduledJobs = listScheduledJobs;
exports.getScheduledJob = getScheduledJob;
exports.deleteRuntimeScheduledJob = deleteRuntimeScheduledJob;
exports.listDueScheduledJobs = listDueScheduledJobs;
exports.claimDueScheduledJob = claimDueScheduledJob;
exports.updateScheduledJobState = updateScheduledJobState;
exports.recordScheduledRun = recordScheduledRun;
exports.listScheduledRuns = listScheduledRuns;
exports.getUncompactedChatMessages = getUncompactedChatMessages;
exports.markMessagesAsCompacted = markMessagesAsCompacted;
const node_crypto_1 = require("node:crypto");
const db_1 = require("./db");
const app_1 = require("../config/app");
function insertArtifact(row) {
    (0, db_1.getDb)().prepare(`INSERT INTO artifacts (id, owner_chat_id, source_trace_id, mime_type, byte_size, sha256, local_path, expires_at, delivered_at, created_at, width, height, observation_summary) VALUES (@id, @owner_chat_id, @source_trace_id, @mime_type, @byte_size, @sha256, @local_path, @expires_at, @delivered_at, @created_at, @width, @height, @observation_summary)`).run(row);
}
function getArtifact(id) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM artifacts WHERE id = ?`).get(id) || null;
}
function getArtifactMetadata(id) {
    return (0, db_1.getDb)().prepare(`SELECT id, mime_type, sha256, byte_size, width, height, observation_summary, delivered_at, created_at
     FROM artifacts WHERE id = ?`).get(id) || null;
}
/** Find an available (undelivered, unexpired) artifact by content hash for
 *  deduplication, so identical media is persisted once (research §182). */
function getArtifactByHash(sha256, ownerChatId) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM artifacts
     WHERE sha256 = ? AND owner_chat_id = ? AND delivered_at IS NULL AND expires_at > ?
     ORDER BY created_at DESC LIMIT 1`).get(sha256, ownerChatId, nowIso()) || null;
}
function markArtifactDelivered(id) {
    (0, db_1.getDb)().prepare(`UPDATE artifacts SET delivered_at = ? WHERE id = ?`).run(nowIso(), id);
}
function deleteArtifact(id) {
    (0, db_1.getDb)().prepare(`DELETE FROM artifacts WHERE id = ?`).run(id);
}
function listExpiredArtifacts(now = nowIso()) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM artifacts WHERE expires_at <= ?`).all(now);
}
function nowIso() {
    return new Date().toISOString();
}
function setJsonState(table, key, value) {
    (0, db_1.getDb)()
        .prepare(`INSERT INTO ${table} (key, value_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(key, JSON.stringify(value), nowIso());
}
function getJsonState(table, key) {
    const row = (0, db_1.getDb)()
        .prepare(`SELECT value_json FROM ${table} WHERE key = ?`)
        .get(key);
    return row ? JSON.parse(row.value_json) : null;
}
function insertTraceEvent(traceId, event, payload) {
    (0, db_1.getDb)()
        .prepare(`INSERT INTO trace_events (trace_id, event, payload_json, created_at)
       VALUES (?, ?, ?, ?)`)
        .run(traceId, event, JSON.stringify(payload ?? {}), nowIso());
    // Prune old trace_events on a throttle so the table cannot grow unbounded in a
    // long-running process (raw-AI JSONL already prunes; trace_events did not).
    const now = Date.now();
    if (now - tracePruneAt > TRACE_PRUNE_INTERVAL_MS) {
        tracePruneAt = now;
        pruneTraceEvents((0, app_1.loadAgentConfig)().logging?.traceRetentionDays ?? 30);
    }
}
/** Best-effort: a retention < 1 day is treated as "do not prune". */
function pruneTraceEvents(retentionDays) {
    if (!Number.isFinite(retentionDays) || retentionDays < 1)
        return 0;
    const cutoffIso = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    return (0, db_1.getDb)().prepare(`DELETE FROM trace_events WHERE created_at < ?`).run(cutoffIso).changes;
}
const TRACE_PRUNE_INTERVAL_MS = 60_000;
let tracePruneAt = 0;
function listTraceEvents(traceId, limit = 50) {
    return (0, db_1.getDb)()
        .prepare(`SELECT trace_id, event, payload_json, created_at
       FROM trace_events
       WHERE trace_id = ?
       ORDER BY created_at ASC, id ASC
       LIMIT ?`)
        .all(traceId, limit);
}
function getLastFailedToolEvent() {
    return ((0, db_1.getDb)()
        .prepare(`SELECT trace_id, event, payload_json, created_at
         FROM trace_events
         WHERE event = 'file.failed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`)
        .get() || null);
}
function getActiveSessionId(chatId) {
    const key = `active_session:${chatId}`;
    const sessionId = getJsonState("runtime_state", key);
    return sessionId || "default";
}
function createRun(input) {
    const now = nowIso();
    (0, db_1.getDb)().prepare(`INSERT INTO runs (id, session_id, principal_id, channel, user_request, status, trace_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`).run(input.id, input.session_id, input.principal_id, input.channel, input.user_request, input.trace_id, now, now);
}
function finishRun(id, status, error) {
    const now = nowIso();
    (0, db_1.getDb)().prepare(`UPDATE runs SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?`).run(status, error || null, now, now, id);
}
function setRunStatus(id, status) {
    (0, db_1.getDb)().prepare(`UPDATE runs SET status = ?, updated_at = ? WHERE id = ?`).run(status, nowIso(), id);
}
function getRun(id) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM runs WHERE id = ?`).get(id) || null;
}
function appendRunStep(input) {
    const db = (0, db_1.getDb)();
    const insert = db.transaction(() => {
        const row = db.prepare(`SELECT COALESCE(MAX(ordinal), -1) AS ordinal FROM run_steps WHERE run_id = ?`).get(input.runId);
        db.prepare(`INSERT INTO run_steps (run_id, ordinal, tool_name, call_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`).run(input.runId, row.ordinal + 1, input.toolName, JSON.stringify(input.call), JSON.stringify(input.result), nowIso());
    });
    insert();
}
function listRunSteps(runId) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY ordinal ASC`).all(runId);
}
function listSessionToolContextBlocks(chatId) {
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
        ? (0, db_1.getDb)().prepare(sql).all(chatId)
        : (0, db_1.getDb)().prepare(sql).all(chatId, sessionId));
}
function resetSession(chatId) {
    const key = `active_session:${chatId}`;
    const sessionId = (0, node_crypto_1.randomUUID)();
    setJsonState("runtime_state", key, sessionId);
    return sessionId;
}
function insertChatMessage(input) {
    const sessionId = input.sessionId || getActiveSessionId(input.chatId);
    const createdAt = input.createdAt || nowIso();
    (0, db_1.getDb)()
        .prepare(`INSERT INTO chat_messages (chat_id, session_id, user_id, role, content, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(input.chatId, sessionId, input.userId, input.role, input.content, input.traceId, createdAt);
}
function listRecentChat(chatId, limit = 20) {
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
    const stmt = (0, db_1.getDb)().prepare(sql);
    const rows = isDefault ? stmt.all(chatId, limit) : stmt.all(chatId, sessionId, limit);
    return rows.reverse();
}
function listActiveSessionChat(chatId) {
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
    return (isDefault ? (0, db_1.getDb)().prepare(sql).all(chatId) : (0, db_1.getDb)().prepare(sql).all(chatId, sessionId));
}
function getContextCheckpoint(chatId, sessionId = getActiveSessionId(chatId)) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM context_checkpoints WHERE chat_id = ? AND session_id = ?`).get(chatId, sessionId) || null;
}
function saveContextCheckpoint(input) {
    const existing = getContextCheckpoint(input.chatId, input.sessionId);
    const now = nowIso();
    const compactionCount = (existing?.compaction_count || 0) + 1;
    (0, db_1.getDb)().prepare(`INSERT INTO context_checkpoints
       (chat_id, session_id, checkpoint_json, first_kept_message_id, tokens_before, compaction_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, session_id) DO UPDATE SET
       checkpoint_json = excluded.checkpoint_json,
       first_kept_message_id = excluded.first_kept_message_id,
       tokens_before = excluded.tokens_before,
       compaction_count = excluded.compaction_count,
       updated_at = excluded.updated_at`).run(input.chatId, input.sessionId, JSON.stringify(input.checkpoint), input.firstKeptMessageId, input.tokensBefore, compactionCount, existing?.created_at || now, now);
    return getContextCheckpoint(input.chatId, input.sessionId);
}
function insertCommandRun(input) {
    (0, db_1.getDb)()
        .prepare(`INSERT INTO command_runs
       (trace_id, chat_id, command_name, label, cwd, command, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(input.traceId, input.chatId, input.commandName, input.label, input.cwd, input.command, input.startedAt);
}
function finishCommandRun(input) {
    (0, db_1.getDb)()
        .prepare(`UPDATE command_runs
       SET status = ?, finished_at = ?, exit_code = ?, output_tail = ?, error_message = ?
       WHERE trace_id = ?`)
        .run(input.status, input.finishedAt, input.exitCode, input.outputTail, input.errorMessage || null, input.traceId);
}
function getLastCommandRun() {
    return ((0, db_1.getDb)()
        .prepare(`SELECT * FROM command_runs ORDER BY started_at DESC, id DESC LIMIT 1`)
        .get() || null);
}
function getLastFailedCommandRun() {
    return ((0, db_1.getDb)()
        .prepare(`SELECT * FROM command_runs
         WHERE status = 'failed'
         ORDER BY finished_at DESC, id DESC
         LIMIT 1`)
        .get() || null);
}
function listRecentCommandRuns(chatId, limit = 3) {
    return (0, db_1.getDb)()
        .prepare(`SELECT * FROM command_runs
       WHERE chat_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ?`)
        .all(chatId, limit);
}
function createPendingApproval(input) {
    (0, db_1.getDb)().prepare(`INSERT INTO pending_approvals
     (id, short_id, run_id, principal_id, chat_id, description, action_digest, payload_json, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(input.id, input.short_id, input.run_id, input.principal_id, input.chat_id, input.description, input.action_digest, input.payload_json, input.expires_at, nowIso());
}
function getPendingApproval(shortId, principalId, chatId) {
    return (0, db_1.getDb)().prepare(`SELECT * FROM pending_approvals WHERE short_id = ? AND principal_id = ? AND chat_id = ?`).get(shortId, principalId, chatId) || null;
}
function listPendingApprovalsByChat(chatId, principalId) {
    const db = (0, db_1.getDb)();
    if (principalId) {
        return db.prepare(`SELECT * FROM pending_approvals WHERE chat_id = ? AND principal_id = ? AND status = 'pending'`).all(chatId, principalId);
    }
    return db.prepare(`SELECT * FROM pending_approvals WHERE chat_id = ? AND status = 'pending'`).all(chatId);
}
function countPendingApprovals() {
    const row = (0, db_1.getDb)()
        .prepare(`SELECT COUNT(*) AS count FROM pending_approvals WHERE status = 'pending' AND expires_at > ?`)
        .get(nowIso());
    return row.count;
}
function resolvePendingApproval(id, status) {
    (0, db_1.getDb)().prepare(`UPDATE pending_approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`).run(status, nowIso(), id);
}
function createApprovalGrant(input) {
    (0, db_1.getDb)().prepare(`INSERT INTO approval_grants
       (id, principal_id, description, scope, run_id, session_id, schedule_id,
        risk_categories_json, resource_hints_json, command_hints_json,
        created_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`).run(input.id, input.principalId, input.description, input.scope, input.runId || null, input.sessionId || null, input.scheduleId || null, input.riskCategories ? JSON.stringify(input.riskCategories) : null, input.resourceHints ? JSON.stringify(input.resourceHints) : null, input.commandHints ? JSON.stringify(input.commandHints) : null, nowIso(), input.expiresAt || null);
}
function listActiveApprovalGrants(input) {
    const now = nowIso();
    return (0, db_1.getDb)().prepare(`SELECT * FROM approval_grants
     WHERE principal_id = ?
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)
       AND (
         (scope = 'run' AND run_id = ?)
         OR (scope = 'session' AND session_id = ?)
         OR (scope = 'schedule' AND schedule_id = ?)
         OR scope = 'persistent'
       )
     ORDER BY created_at DESC`).all(input.principalId, now, input.runId || null, input.sessionId || null, input.scheduleId || null);
}
function revokeApprovalGrant(id) {
    (0, db_1.getDb)().prepare(`UPDATE approval_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`).run(nowIso(), id);
}
function upsertScheduledJob(input) {
    const now = nowIso();
    (0, db_1.getDb)()
        .prepare(`INSERT INTO scheduled_jobs
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
          OR scheduled_jobs.prepare_effect_json IS NOT excluded.prepare_effect_json)`)
        .run(input.name, input.source || "config", input.label, input.commandName, input.cronExpr, input.timezone || "UTC", input.enabled ? 1 : 0, input.delivery, input.notifyOnChangeOnly ? 1 : 0, input.prepareEffect === undefined ? null : JSON.stringify(input.prepareEffect), input.nextRunAt ?? null, now, now);
}
/** Config is authoritative only for schedules it owns; runtime schedules are never touched. */
function disableRemovedConfigScheduledJobs(activeNames) {
    const now = nowIso();
    const db = (0, db_1.getDb)();
    const filter = activeNames.length > 0
        ? `AND name NOT IN (${activeNames.map(() => "?").join(", ")})`
        : "";
    db.prepare(`UPDATE scheduled_jobs
     SET enabled = 0, next_run_at = NULL, lease_owner = NULL, lease_until = NULL,
         version = version + 1, updated_at = ?
     WHERE source = 'config' AND enabled = 1 ${filter}`).run(now, ...activeNames);
}
function listScheduledJobs() {
    return (0, db_1.getDb)()
        .prepare(`SELECT * FROM scheduled_jobs ORDER BY name ASC`)
        .all();
}
function getScheduledJob(name) {
    return ((0, db_1.getDb)()
        .prepare(`SELECT * FROM scheduled_jobs WHERE name = ?`)
        .get(name) || null);
}
/** Runtime schedules are owned by their creator, never by config seeding. */
function deleteRuntimeScheduledJob(name) {
    return (0, db_1.getDb)()
        .prepare(`DELETE FROM scheduled_jobs WHERE name = ? AND source = 'runtime'`)
        .run(name).changes === 1;
}
function listDueScheduledJobs(now = nowIso()) {
    return (0, db_1.getDb)()
        .prepare(`SELECT * FROM scheduled_jobs
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC, name ASC`)
        .all(now);
}
function claimDueScheduledJob(input) {
    const now = input.now || nowIso();
    const db = (0, db_1.getDb)();
    const transaction = db.transaction(() => {
        const current = db
            .prepare(`SELECT * FROM scheduled_jobs WHERE name = ?`)
            .get(input.name);
        if (!current ||
            current.enabled !== 1 ||
            !current.next_run_at ||
            current.next_run_at > now ||
            (current.lease_until && current.lease_until > now)) {
            return null;
        }
        const result = db
            .prepare(`UPDATE scheduled_jobs
         SET lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE name = ?
           AND enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
           AND (lease_until IS NULL OR lease_until <= ?)`)
            .run(input.leaseOwner, input.leaseUntil, now, input.name, now, now);
        if (result.changes !== 1)
            return null;
        return db.prepare(`SELECT * FROM scheduled_jobs WHERE name = ?`).get(input.name);
    });
    return transaction();
}
function updateScheduledJobState(input) {
    const current = getScheduledJob(input.name);
    if (!current)
        throw new Error(`Scheduled job not found: ${input.name}`);
    if (input.expectedVersion !== undefined && current.version !== input.expectedVersion) {
        throw new Error(`Scheduled job changed. Expected version ${input.expectedVersion}, got ${current.version}.`);
    }
    const result = (0, db_1.getDb)()
        .prepare(`UPDATE scheduled_jobs
       SET enabled = ?, cron_expr = ?, delivery = ?, next_run_at = ?,
           version = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE name = ?`)
        .run(input.enabled === undefined ? current.enabled : input.enabled ? 1 : 0, input.cronExpr === undefined ? current.cron_expr : input.cronExpr, input.delivery ?? current.delivery, input.nextRunAt === undefined ? current.next_run_at : input.nextRunAt, current.version + 1, nowIso(), input.name);
    if (result.changes !== 1)
        throw new Error(`Scheduled job update failed: ${input.name}`);
    return getScheduledJob(input.name);
}
function recordScheduledRun(input) {
    const db = (0, db_1.getDb)();
    const transaction = db.transaction(() => {
        db.prepare(`INSERT INTO scheduled_runs
       (job_name, trace_id, status, exit_code, output_tail, output_digest,
        notification_sent, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.jobName, input.traceId, input.status, input.exitCode, input.outputTail, input.outputDigest, input.notificationSent ? 1 : 0, input.startedAt, input.finishedAt);
        db.prepare(`UPDATE scheduled_jobs
       SET next_run_at = ?, last_run_at = ?, last_status = ?, last_trace_id = ?,
           last_output_digest = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE name = ? AND (? IS NULL OR lease_owner = ?)`).run(input.nextRunAt, input.finishedAt, input.status, input.traceId, input.outputDigest, nowIso(), input.jobName, input.leaseOwner || null, input.leaseOwner || null);
    });
    transaction();
}
function listScheduledRuns(jobName, limit = 5) {
    return (0, db_1.getDb)()
        .prepare(`SELECT * FROM scheduled_runs
       WHERE job_name = ?
       ORDER BY finished_at DESC, id DESC
       LIMIT ?`)
        .all(jobName, limit);
}
function getUncompactedChatMessages(chatId, sessionId) {
    return (0, db_1.getDb)()
        .prepare(`SELECT id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ? AND session_id = ?
       ORDER BY created_at ASC, id ASC`)
        .all(chatId, sessionId);
}
function markMessagesAsCompacted(messageIds, compactedSessionId) {
    const db = (0, db_1.getDb)();
    const placeholders = messageIds.map(() => "?").join(",");
    db.prepare(`UPDATE chat_messages
     SET session_id = ?
     WHERE id IN (${placeholders})`).run(compactedSessionId, ...messageIds);
}
