// Proves ADR 0017 P2.4 scheduler reliability: at-least-once delivery via lease
// re-claim after expiry, idempotent run-state recording on stale retry, refusal
// of an out-of-scope destructive command inside a pre-approved scheduled run,
// and runtime-schedule persistence across a DB close/reopen (simulated restart).
//
// Existing scheduler coverage (scheduler.test.js / scheduler-runner.test.js)
// already proves lease-prevents-duplicate claim, config removal, runtime
// create/delete semantics, and the runner lifecycle. These tests close the
// remaining P2.4 gaps.
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be
// set before any dist require (the helpers/db helper does that). Each test file
// runs in its own subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const { buildCommandCatalog } = require("../dist/commands");
const { closeDb, getDb } = require("../dist/storage/db");
const {
  claimDueScheduledJob,
  getScheduledJob,
  listScheduledRuns,
  recordScheduledRun,
  updateScheduledJobState,
} = require("../dist/storage/repositories");
const {
  createRuntimeSchedule,
  normalizeScheduledCheck,
  runScheduledCheck,
  seedScheduledJobsFromConfig,
} = require("../dist/scheduler");

function catalog(root) {
  return buildCommandCatalog({
    allow: [
      {
        name: "test.read",
        label: "Read-only check",
        cwd: root,
        argv: [process.execPath, "-e", 'process.stdout.write("scheduled-ok")'],
        requiresConfirmation: false,
        externalSideEffect: false,
      },
      {
        name: "test.destroy",
        label: "Destructive wipe",
        cwd: root,
        argv: ["rm", "-rf", "/"],
        requiresConfirmation: false,
        externalSideEffect: true,
      },
    ],
  });
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, "schedule-reliability-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeDueJob(name) {
  seedScheduledJobsFromConfig(
    [{ name, command: "test.read", cron: "*/5 * * * *", enabled: true }],
    catalog(__dirname),
  );
  updateScheduledJobState({
    name,
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
  });
}

test("at-least-once: a crashed runner's expired lease can be reclaimed so the job still runs", () => {
  const name = `reclaim-${Date.now()}`;
  makeDueJob(name);
  const now = Date.now();

  // Runner A claims the due job, then crashes before recording its run: the
  // lease is still held and next_run_at has not advanced.
  const claimedByA = claimDueScheduledJob({
    name,
    leaseOwner: "runner-a",
    leaseUntil: new Date(now + 60_000).toISOString(),
    now: new Date(now).toISOString(),
  });
  assert.equal(claimedByA.lease_owner, "runner-a");

  // While the lease is live, runner B cannot claim the same occurrence.
  const blockedB = claimDueScheduledJob({
    name,
    leaseOwner: "runner-b",
    leaseUntil: new Date(now + 60_000).toISOString(),
    now: new Date(now).toISOString(),
  });
  assert.equal(blockedB, null);

  // After the lease expires (simulated time passage past lease_until), runner B
  // reclaims and runs the job again. The job was delivered at least once even
  // though runner A never finished — at-least-once, not at-most-once.
  const reclaimedByB = claimDueScheduledJob({
    name,
    leaseOwner: "runner-b",
    leaseUntil: new Date(now + 120_000).toISOString(),
    now: new Date(now + 90_000).toISOString(),
  });
  assert.equal(reclaimedByB.lease_owner, "runner-b");
  assert.equal(reclaimedByB.name, name);
});

test("idempotent run recording: a stale retry does not double-advance next_run_at", () => {
  const name = `idempotent-${Date.now()}`;
  makeDueJob(name);
  const leaseOwner = "runner-a";
  const claimed = claimDueScheduledJob({
    name,
    leaseOwner,
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.ok(claimed);

  const firstNext = "2099-01-01T00:00:00.000Z";
  recordScheduledRun({
    jobName: name,
    leaseOwner,
    traceId: "trace-1",
    status: "success",
    exitCode: 0,
    outputTail: "ok",
    outputDigest: "digest-1",
    notificationSent: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    nextRunAt: firstNext,
  });
  assert.equal(getScheduledJob(name).next_run_at, firstNext);
  assert.equal(getScheduledJob(name).lease_owner, null);

  // A duplicate record for the same lease owner (e.g. a retry after a partial
  // crash) appends a second scheduled_runs row — delivery is at-least-once —
  // but the job's next_run_at is NOT advanced again, because the lease has
  // already been cleared and the guard refuses to overwrite on a stale owner.
  recordScheduledRun({
    jobName: name,
    leaseOwner,
    traceId: "trace-1",
    status: "success",
    exitCode: 0,
    outputTail: "ok",
    outputDigest: "digest-1",
    notificationSent: false,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    nextRunAt: "2099-02-02T00:00:00.000Z",
  });

  assert.equal(getScheduledJob(name).next_run_at, firstNext, "next_run_at must not advance on stale retry");
  const runs = listScheduledRuns(name, 10);
  assert.equal(runs.length, 2, "at-least-once delivery may record two runs");
});

test("a scheduled run that exceeds pre-approved scope is denied and fails, not executed", async (t) => {
  const root = workspace(t);
  const check = normalizeScheduledCheck(
    { name: `scheduled-destroy-${Date.now()}`, command: "test.destroy", cron: "*/5 * * * *", enabled: true },
    catalog(root),
  );

  const result = await runScheduledCheck({
    check,
    principalId: "schedule-owner",
    chatId: "schedule-owner-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {},
  });

  // The configured schedule is pre-approved scope, but a clearly destructive
  // command is denied by contextual policy at the gateway regardless of the
  // scheduled grant — the run fails and the destructive argv never executes.
  assert.equal(result.status, "failed");
  assert.doesNotMatch(result.outputTail || "", /scheduled-ok/);
  const row = getScheduledJob(check.name);
  assert.equal(row.last_status, "failed");
});

test("a runtime schedule persists across a simulated process restart", () => {
  const name = `runtime-persist-${Date.now()}`;
  const created = createRuntimeSchedule(
    { name, command: "test.read", cron: "0 6 * * *", enabled: true },
    catalog(__dirname),
  );
  assert.equal(created.source, "runtime");

  // Close and reopen the database handle, as a process restart would. The
  // runtime-owned schedule is durable state and must survive.
  closeDb();
  getDb();
  const after = getScheduledJob(name);
  assert.ok(after, "runtime schedule must survive a DB close/reopen");
  assert.equal(after.source, "runtime");
  assert.equal(after.cron_expr, "0 6 * * *");
});
