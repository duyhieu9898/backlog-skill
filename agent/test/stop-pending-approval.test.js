// Proves ADR 0017 P2.3 (fix B): an owner `/stop` cancels a run that is paused
// waiting for approval. Before the fix, a paused run had already left
// `activeRuns` (its entry is cleared in `execute`'s finally block), so `/stop`
// found nothing to cancel and the run only ended when its pending approval
// expired on its own. `/stop` now falls back to cancelling still-pending
// approvals for the chat.
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be
// set before any dist require. Each test file runs in its own subprocess.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-pending-approval-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { closeDb } = require("../dist/storage/db");
const {
  createRun,
  getRun,
  createPendingApproval,
  getPendingApproval,
  setRunStatus,
} = require("../dist/storage/repositories");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const skillsPath = path.join(__dirname, "..", "..", "skills");
const userId = "user";

function stopMessage(chatId, suffix) {
  return {
    traceId: `stop-pending-stop-${suffix}`,
    provider: "telegram",
    chatId,
    userId,
    text: "/stop",
    timestamp: new Date(),
  };
}

// Creates a run paused at approval: a run row in `waiting_approval` plus a
// `pending` approval row for the chat.
function seedPausedRun(chatId, suffix) {
  const runId = `stop-pending-run-${suffix}`;
  const shortId = crypto.randomBytes(4).toString("hex");
  createRun({
    id: runId,
    session_id: "default",
    principal_id: userId,
    channel: "telegram",
    user_request: "do something consequential",
    trace_id: runId,
  });
  createPendingApproval({
    id: crypto.randomUUID(),
    short_id: shortId,
    run_id: runId,
    principal_id: userId,
    chat_id: chatId,
    description: "Cho phép chạy effect này trong run.",
    action_digest: crypto.randomBytes(16).toString("hex"),
    payload_json: "{}",
    expires_at: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
  });
  setRunStatus(runId, "waiting_approval");
  return { runId, shortId };
}

test("/stop cancels a run paused waiting for approval", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chatId = `stop-pending-chat-${suffix}`;
  const { runId, shortId } = seedPausedRun(chatId, suffix);

  assert.equal(getRun(runId).status, "waiting_approval");
  assert.equal(getPendingApproval(shortId, userId, chatId).status, "pending");

  const router = new Router(new SkillRegistry(skillsPath));
  const reply = await router.route(stopMessage(chatId, suffix));

  assert.match(reply, /Đã huỷ run đang chờ xác nhận/);
  assert.match(reply, new RegExp(runId));
  assert.equal(getPendingApproval(shortId, userId, chatId).status, "invalidated");
  assert.equal(getRun(runId).status, "cancelled");

  // Nothing left to stop.
  const again = await router.route(stopMessage(chatId, `${suffix}-2`));
  assert.equal(again, "Không có run hoặc lệnh nào đang chạy.");
});

test("/stop reports a count when several runs are paused in one chat", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chatId = `stop-pending-multi-${suffix}`;
  seedPausedRun(chatId, `${suffix}-a`);
  seedPausedRun(chatId, `${suffix}-b`);

  const router = new Router(new SkillRegistry(skillsPath));
  const reply = await router.route(stopMessage(chatId, suffix));

  assert.equal(reply, "Đã huỷ 2 run đang chờ xác nhận.");
});

test("/stop leaves another chat's paused run untouched", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const chatA = `stop-pending-other-${suffix}`;
  const chatB = `stop-pending-target-${suffix}`;
  const { runId: runA, shortId: shortA } = seedPausedRun(chatA, `${suffix}-a`);

  const router = new Router(new SkillRegistry(skillsPath));
  const reply = await router.route(stopMessage(chatB, suffix));

  assert.equal(reply, "Không có run hoặc lệnh nào đang chạy.");
  // The other chat's run is still paused and pending.
  assert.equal(getRun(runA).status, "waiting_approval");
  assert.equal(getPendingApproval(shortA, userId, chatA).status, "pending");
});
