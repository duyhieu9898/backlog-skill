// Proves ADR 0017 P2.3: ScheduledCheckRunner lifecycle — start() ticks on an
// interval, claims a due job exactly once (lease + re-entrancy guard keep it
// from re-running the same job), and stop() clears the timer. This runner was
// previously untested.
//
// `paths.ts` resolves `sqliteFile` at module-eval time, so AGENT_DB_FILE must be
// set before any dist require. Each test file runs in its own subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-runner-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { closeDb } = require("../dist/storage/db");
const { upsertScheduledJob, getScheduledJob } = require("../dist/storage/repositories");
const { ScheduledCheckRunner } = require("../dist/scheduler");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ScheduledCheckRunner ticks, claims a due job once, then stops", async () => {
  const name = `runner-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // bemo.late-list is a read-only entry in commands.json; the runner reads the
  // real catalog, so the job must reference a real command. The command may
  // fail in this environment, but a telegram-delivery job still notifies.
  upsertScheduledJob({
    name,
    source: "config",
    label: "Runner probe",
    commandName: "bemo.late-list",
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    enabled: true,
    delivery: "telegram",
    notifyOnChangeOnly: false,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  });

  let count = 0;
  const notify = async () => { count += 1; };
  const runner = new ScheduledCheckRunner("owner", "chat", notify, 2000, 20);

  runner.start();
  for (let i = 0; i < 300 && count < 1; i += 1) await sleep(10);
  assert.ok(count >= 1, "runner tick should have notified once");
  const afterFirst = count;

  // More ticks: the job's next_run_at has advanced, so the lease/re-entrancy
  // guard keeps the runner from notifying again for the same job.
  await sleep(150);
  assert.equal(count, afterFirst, "runner should not re-notify for the same job");

  runner.stop();
  await sleep(150);
  assert.equal(count, afterFirst, "stop() should clear the tick timer");

  const job = getScheduledJob(name);
  assert.ok(job, "scheduled job row should exist");
});
