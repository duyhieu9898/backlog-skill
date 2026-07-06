"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowIso = nowIso;
exports.setJsonState = setJsonState;
exports.getJsonState = getJsonState;
exports.insertTraceEvent = insertTraceEvent;
exports.listTraceEvents = listTraceEvents;
exports.getLastFailedToolEvent = getLastFailedToolEvent;
exports.insertChatMessage = insertChatMessage;
exports.listRecentChat = listRecentChat;
exports.insertCommandRun = insertCommandRun;
exports.finishCommandRun = finishCommandRun;
exports.getLastCommandRun = getLastCommandRun;
exports.getLastFailedCommandRun = getLastFailedCommandRun;
exports.listRecentCommandRuns = listRecentCommandRuns;
exports.upsertPendingConfirmation = upsertPendingConfirmation;
exports.getPendingConfirmation = getPendingConfirmation;
exports.deletePendingConfirmation = deletePendingConfirmation;
exports.countPendingConfirmations = countPendingConfirmations;
const db_1 = require("./db");
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
}
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
function insertChatMessage(input) {
    (0, db_1.getDb)()
        .prepare(`INSERT INTO chat_messages (chat_id, user_id, role, content, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`)
        .run(input.chatId, input.userId, input.role, input.content, input.traceId, nowIso());
}
function listRecentChat(chatId, limit = 20) {
    return (0, db_1.getDb)()
        .prepare(`SELECT chat_id, user_id, role, content, trace_id, created_at
       FROM chat_messages
       WHERE chat_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`)
        .all(chatId, limit)
        .reverse();
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
function upsertPendingConfirmation(input) {
    (0, db_1.getDb)()
        .prepare(`INSERT INTO pending_confirmations
       (chat_id, trace_id, command_name, payload_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         trace_id = excluded.trace_id,
         command_name = excluded.command_name,
         payload_json = excluded.payload_json,
         expires_at = excluded.expires_at,
         created_at = excluded.created_at`)
        .run(input.chatId, input.traceId, input.commandName, JSON.stringify(input.payload), input.expiresAt, nowIso());
}
function getPendingConfirmation(chatId) {
    return ((0, db_1.getDb)()
        .prepare(`SELECT * FROM pending_confirmations WHERE chat_id = ?`)
        .get(chatId) || null);
}
function deletePendingConfirmation(chatId) {
    (0, db_1.getDb)().prepare(`DELETE FROM pending_confirmations WHERE chat_id = ?`).run(chatId);
}
function countPendingConfirmations() {
    const row = (0, db_1.getDb)()
        .prepare(`SELECT COUNT(*) AS count FROM pending_confirmations WHERE expires_at > ?`)
        .get(nowIso());
    return row.count;
}
