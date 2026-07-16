const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const { buildCommandCatalog } = require("../dist/commands");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");
const {
  claimDueScheduledJob,
  getJsonState,
  getRun,
  getScheduledJob,
  listRunSteps,
  upsertScheduledJob,
  updateScheduledJobState,
} = require("../dist/storage/repositories");
const {
  applyScheduleUpdate,
  createRuntimeSchedule,
  findScheduledCheck,
  formatScheduleList,
  formatScheduleHistory,
  normalizeScheduledCheck,
  nextRunAtFor,
  runScheduledCheck,
  removeRuntimeSchedule,
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

test("scheduled checks accept configured actions and reject only unknown commands", (t) => {
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
  assert.equal(
    normalizeScheduledCheck(
      { name: "configured-write", command: "test.write", cron: "*/15 * * * *", enabled: true },
      commands,
    ).command.name,
    "test.write",
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

test("config seeding owns config schedules but never overwrites a runtime schedule", () => {
  const name = `runtime-owned-${Date.now()}`;
  upsertScheduledJob({
    name,
    source: "runtime",
    label: "Runtime schedule",
    commandName: "test.read",
    cronExpr: "0 3 * * *",
    timezone: "UTC",
    enabled: true,
    delivery: "silent",
    notifyOnChangeOnly: false,
  });

  seedScheduledJobsFromConfig([
    { name, label: "Config must not win", command: "test.read", cron: "0 4 * * *", enabled: true },
  ], catalog(__dirname));

  const row = getScheduledJob(name);
  assert.equal(row.source, "runtime");
  assert.equal(row.label, "Runtime schedule");
  assert.equal(row.cron_expr, "0 3 * * *");
});

test("removing a config schedule disables it without touching runtime schedules", () => {
  const configured = `removed-config-${Date.now()}`;
  const runtime = `remaining-runtime-${Date.now()}`;
  seedScheduledJobsFromConfig([
    { name: configured, command: "test.read", cron: "*/5 * * * *", enabled: true },
  ], catalog(__dirname));
  upsertScheduledJob({
    name: runtime,
    source: "runtime",
    label: "Runtime schedule",
    commandName: "test.read",
    cronExpr: "*/5 * * * *",
    timezone: "UTC",
    enabled: true,
    delivery: "silent",
    notifyOnChangeOnly: false,
  });

  seedScheduledJobsFromConfig([], catalog(__dirname));

  assert.equal(getScheduledJob(configured).enabled, 0);
  assert.equal(getScheduledJob(runtime).enabled, 1);
});

test("runtime schedules persist independently and cannot replace config schedules", () => {
  const commands = catalog(__dirname);
  const runtimeName = `runtime-created-${Date.now()}`;
  const created = createRuntimeSchedule(
    { name: runtimeName, command: "test.write", cron: "0 4 * * *", enabled: true },
    commands,
  );
  assert.equal(created.source, "runtime");
  assert.equal(getScheduledJob(runtimeName).source, "runtime");
  assert.equal(removeRuntimeSchedule(runtimeName), true);
  assert.equal(getScheduledJob(runtimeName), null);

  const configName = `config-owned-${Date.now()}`;
  seedScheduledJobsFromConfig([{ name: configName, command: "test.read", cron: "0 4 * * *", enabled: true }], commands);
  assert.throws(
    () => createRuntimeSchedule({ name: configName, command: "test.write", cron: "0 5 * * *" }, commands),
    /owned by config\.json/,
  );
  assert.equal(removeRuntimeSchedule(configName), false);
});

test("scheduled run records traceable command result and last scheduled state", async (t) => {
  const root = workspace(t);
  const check = normalizeScheduledCheck(
    { name: "manual-read", command: "test.read", cron: "*/5 * * * *" },
    catalog(root),
  );
  const result = await runScheduledCheck({
    check,
    principalId: "schedule-test-user",
    chatId: "schedule-test-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {},
  });
  const last = getJsonState("runtime_state", "lastScheduledRun");

  assert.equal(result.status, "success");
  assert.match(result.outputTail, /scheduled-ok/);
  assert.equal(last.name, "manual-read");
  assert.equal(last.traceId, result.traceId);
  assert.equal(getRun(result.traceId).status, "completed");
  assert.deepEqual(listRunSteps(result.traceId).map((step) => step.tool_name), ["command.test.read"]);
  assert.match(formatScheduleHistory("manual-read"), /SUCCESS manual-read/);
});

test("configured schedule runs an in-scope side-effecting command without recurring approval", async (t) => {
  const root = workspace(t);
  const check = normalizeScheduledCheck(
    { name: `scheduled-write-${Date.now()}`, command: "test.write", cron: "*/5 * * * *", enabled: true },
    catalog(root),
  );
  const result = await runScheduledCheck({
    check,
    principalId: "schedule-owner",
    chatId: "schedule-owner-chat",
    defaultTimeoutMs: 5000,
  });
  assert.equal(result.status, "success");
  assert.match(result.outputTail, /write/);
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

test("Router creates and deletes a runtime schedule without an approval loop", async () => {
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const name = `runtime-cli-${Date.now()}`;
  const base = {
    provider: "cli",
    chatId: `runtime-cli-chat-${Date.now()}`,
    userId: "test-user",
    timestamp: new Date(),
  };
  const created = await router.route({
    ...base,
    traceId: `runtime-cli-add-${Date.now()}`,
    text: `/schedule add ${name} */5 * * * * bemo.late-list`,
  });
  assert.match(created, new RegExp(`Created runtime schedule ${name}`));
  assert.equal(getScheduledJob(name).source, "runtime");

  const deleted = await router.route({
    ...base,
    traceId: `runtime-cli-delete-${Date.now()}`,
    text: `/schedule delete ${name}`,
  });
  assert.equal(deleted, `Deleted runtime schedule ${name}.`);
  assert.equal(getScheduledJob(name), null);
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

test("config seeding refreshes all controls for config-owned schedules", () => {
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
  assert.equal(row.enabled, 1);
  assert.equal(row.delivery, "telegram");
  assert.equal(row.notify_on_change_only, 0);
  assert.notEqual(row.next_run_at, null);
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
    principalId: "change-only-user",
    chatId: "change-only-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {
      sent += 1;
    },
  });
  await runScheduledCheck({
    check,
    principalId: "change-only-user",
    chatId: "change-only-chat",
    defaultTimeoutMs: 5000,
    notify: async () => {
      sent += 1;
    },
  });

  assert.equal(sent, 1);
});
