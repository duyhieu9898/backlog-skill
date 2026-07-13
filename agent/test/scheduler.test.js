const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildCommandCatalog } = require("../dist/commands");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");
const {
  claimDueScheduledJob,
  getJsonState,
  getScheduledJob,
  updateScheduledJobState,
} = require("../dist/storage/repositories");
const {
  applyScheduleUpdate,
  findScheduledCheck,
  formatScheduleList,
  formatScheduleHistory,
  normalizeScheduledCheck,
  nextRunAtFor,
  runScheduledCheck,
  scheduleUpdatePreview,
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
        name: "test.write",
        label: "Risky write",
        cwd: root,
        argv: [process.execPath, "-e", 'process.stdout.write("write")'],
        requiresConfirmation: true,
        externalSideEffect: true,
      },
    ],
  });
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(__dirname, "schedule-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("scheduled checks must reference read-only allowlisted commands", (t) => {
  const root = workspace(t);
  const commands = catalog(root);
  const check = normalizeScheduledCheck(
    {
      name: "daily-read",
      label: "Daily read",
      command: "test.read",
      cron: "*/15 * * * *",
      enabled: true,
    },
    commands,
  );

  assert.equal(check.name, "daily-read");
  assert.equal(check.label, "Daily read");
  assert.equal(check.enabled, true);
  assert.match(formatScheduleList([check]), /daily-read - Daily read \[enabled, cron: \*\/15 \* \* \* \*, telegram\]/);
  assert.throws(
    () =>
      normalizeScheduledCheck(
        { name: "bad-write", command: "test.write", cron: "*/15 * * * *" },
        commands,
      ),
    /read-only command/,
  );
  assert.throws(
    () =>
      normalizeScheduledCheck(
        { name: "missing", command: "test.missing", cron: "*/15 * * * *" },
        commands,
      ),
    /unknown command/,
  );
});

test("daily schedules calculate the next fixed time in the configured timezone", (t) => {
  const check = normalizeScheduledCheck(
    { name: "daily-fixed", command: "test.read", cron: "0 17 * * *", enabled: true },
    catalog(workspace(t)),
  );

  assert.equal(check.cron, "0 17 * * *");
  assert.equal(nextRunAtFor(check, new Date("2026-07-13T09:59:59.000Z"), "Asia/Ho_Chi_Minh"), "2026-07-13T10:00:00.000Z");
  assert.equal(nextRunAtFor(check, new Date("2026-07-13T10:00:00.000Z"), "Asia/Ho_Chi_Minh"), "2026-07-14T10:00:00.000Z");
  assert.match(formatScheduleList([check]), /daily-fixed - Read-only check \[enabled, cron: 0 17 \* \* \*, telegram\]/);
});

test("config seeding replaces an interval schedule with a cron schedule", () => {
  const name = `seed-cron-${Date.now()}`;
  seedScheduledJobsFromConfig([
    { name, command: "test.read", cron: "0 1 * * *", enabled: true },
  ], catalog(__dirname));
  const first = getScheduledJob(name);

  seedScheduledJobsFromConfig([
    { name, command: "test.read", cron: "0 2 * * *", enabled: true },
  ], catalog(__dirname));
  const updated = getScheduledJob(name);

  assert.equal(updated.cron_expr, "0 2 * * *");
  assert.notEqual(updated.next_run_at, first.next_run_at);
});

test("scheduled run records traceable command result and last scheduled state", async (t) => {
  const root = workspace(t);
  const check = normalizeScheduledCheck(
    { name: "manual-read", command: "test.read", cron: "*/5 * * * *" },
    catalog(root),
  );
  const result = await runScheduledCheck({
    check,
    chatId: "schedule-test-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {},
  });
  const last = getJsonState("runtime_state", "lastScheduledRun");

  assert.equal(result.status, "success");
  assert.match(result.outputTail, /scheduled-ok/);
  assert.equal(last.name, "manual-read");
  assert.equal(last.traceId, result.traceId);
  assert.match(formatScheduleHistory("manual-read"), /SUCCESS manual-read/);
});

test("findScheduledCheck resolves named checks from supplied list", (t) => {
  const root = workspace(t);
  const check = normalizeScheduledCheck(
    { name: "named-read", command: "test.read", cron: "*/5 * * * *" },
    catalog(root),
  );

  assert.equal(findScheduledCheck("named-read", [check]), check);
  assert.equal(findScheduledCheck("other", [check]), null);
});

test("Router exposes configured schedule listing", async () => {
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const reply = await router.route({
    traceId: `schedule-list-${Date.now()}`,
    provider: "telegram",
    chatId: "schedule-list-chat",
    userId: "test-user",
    text: "/schedule",
    timestamp: new Date(),
  });

  assert.match(reply, /bemo-late - Bemo late-day read-only check \[enabled, cron: 0 17 \* \* 1-5, telegram, change-only\]/);
});

test("schedule update preview requires exact digest before applying", () => {
  seedScheduledJobsFromConfig([
    {
      name: "digest-read",
      command: "test.read",
      cron: "*/5 * * * *",
      enabled: false,
    },
  ], catalog(__dirname));
  const update = { action: "cron", name: "digest-read", value: "0 9 * * *" };
  const first = scheduleUpdatePreview(update);
  const second = scheduleUpdatePreview(update);

  assert.equal(first.digest, second.digest);
  assert.equal(applyScheduleUpdate(update), "Updated digest-read cron to: 0 9 * * *");
});

test("config seeding preserves runtime schedule controls", () => {
  const name = `seed-preserve-${Date.now()}`;
  seedScheduledJobsFromConfig([
    {
      name,
      label: "Initial label",
      command: "test.read",
      cron: "*/5 * * * *",
      enabled: true,
      delivery: "telegram",
      notifyOnChangeOnly: true,
    },
  ], catalog(__dirname));

  updateScheduledJobState({
    name,
    enabled: false,
    delivery: "silent",
    nextRunAt: null,
  });
  seedScheduledJobsFromConfig([
    {
      name,
      label: "Updated label",
      command: "test.read",
      cron: "0 10 * * *",
      enabled: true,
      delivery: "telegram",
      notifyOnChangeOnly: false,
    },
  ], catalog(__dirname));

  const row = getScheduledJob(name);
  assert.equal(row.label, "Updated label");
  assert.equal(row.cron_expr, "0 10 * * *");
  assert.equal(row.enabled, 0);
  assert.equal(row.delivery, "silent");
  assert.equal(row.notify_on_change_only, 1);
  assert.equal(row.next_run_at, null);
});

test("config seeding does not bump version when metadata is unchanged", () => {
  const name = `seed-version-${Date.now()}`;
  const config = {
    name,
    label: "Stable label",
    command: "test.read",
    cron: "*/5 * * * *",
    enabled: true,
    delivery: "telegram",
    notifyOnChangeOnly: true,
  };
  seedScheduledJobsFromConfig([config], catalog(__dirname));
  const first = getScheduledJob(name);

  seedScheduledJobsFromConfig([config], catalog(__dirname));
  const second = getScheduledJob(name);
  seedScheduledJobsFromConfig([{ ...config, label: "Changed label" }], catalog(__dirname));
  const third = getScheduledJob(name);

  assert.equal(second.version, first.version);
  assert.equal(third.version, first.version + 1);
});

test("due job claim uses a lease to prevent duplicate runners", () => {
  const name = `claim-${Date.now()}`;
  seedScheduledJobsFromConfig([
    {
      name,
      command: "test.read",
      cron: "*/5 * * * *",
      enabled: true,
    },
  ], catalog(__dirname));
  updateScheduledJobState({
    name,
    nextRunAt: new Date(Date.now() - 1000).toISOString(),
  });

  const first = claimDueScheduledJob({
    name,
    leaseOwner: "runner-a",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const second = claimDueScheduledJob({
    name,
    leaseOwner: "runner-b",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(first.name, name);
  assert.equal(first.lease_owner, "runner-a");
  assert.equal(second, null);
});

test("schedule updates reject stale expected versions", () => {
  const name = `versioned-update-${Date.now()}`;
  seedScheduledJobsFromConfig([
    {
      name,
      command: "test.read",
      cron: "*/5 * * * *",
      enabled: true,
    },
  ], catalog(__dirname));
  const initial = getScheduledJob(name);

  assert.equal(applyScheduleUpdate({ action: "cron", name, value: "0 8 * * *", expectedVersion: initial.version }), `Updated ${name} cron to: 0 8 * * *`);
  assert.match(
    applyScheduleUpdate({ action: "delivery", name, value: "silent", expectedVersion: initial.version }),
    /Scheduled job changed/,
  );
  assert.equal(getScheduledJob(name).delivery, "telegram");
});

test("change-only delivery suppresses duplicate successful notification", async (t) => {
  const root = workspace(t);
  const name = `change-only-${Date.now()}`;
  const check = {
    ...normalizeScheduledCheck(
      { name, command: "test.read", cron: "*/5 * * * *", notifyOnChangeOnly: true },
      catalog(root),
    ),
    notifyOnChangeOnly: true,
  };
  let sent = 0;
  await runScheduledCheck({
    check,
    chatId: "change-only-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {
      sent += 1;
    },
  });
  await runScheduledCheck({
    check,
    chatId: "change-only-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {
      sent += 1;
    },
  });

  assert.equal(sent, 1);
});
