const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildCommandCatalog } = require("../dist/commands");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");
const { getJsonState, getScheduledJob, updateScheduledJobState } = require("../dist/storage/repositories");
const {
  applyScheduleUpdate,
  findScheduledCheck,
  formatScheduleList,
  formatScheduleHistory,
  normalizeScheduledCheck,
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
      intervalMinutes: 15,
      enabled: true,
    },
    commands,
  );

  assert.equal(check.name, "daily-read");
  assert.equal(check.label, "Daily read");
  assert.equal(check.enabled, true);
  assert.match(formatScheduleList([check]), /daily-read - Daily read \[enabled, every 15m, telegram\]/);
  assert.throws(
    () =>
      normalizeScheduledCheck(
        { name: "bad-write", command: "test.write", intervalMinutes: 15 },
        commands,
      ),
    /read-only command/,
  );
  assert.throws(
    () =>
      normalizeScheduledCheck(
        { name: "missing", command: "test.missing", intervalMinutes: 15 },
        commands,
      ),
    /unknown command/,
  );
});

test("scheduled run records traceable command result and last scheduled state", async (t) => {
  const root = workspace(t);
  const check = normalizeScheduledCheck(
    { name: "manual-read", command: "test.read", intervalMinutes: 5 },
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
    { name: "named-read", command: "test.read", intervalMinutes: 5 },
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

  assert.match(reply, /bemo-late - Bemo late-day read-only check \[enabled, every 60m, telegram, change-only\]/);
});

test("schedule update preview requires exact digest before applying", () => {
  seedScheduledJobsFromConfig([
    {
      name: "digest-read",
      command: "test.read",
      intervalMinutes: 5,
      enabled: false,
    },
  ], catalog(__dirname));
  const update = { action: "interval", name: "digest-read", value: 12 };
  const first = scheduleUpdatePreview(update);
  const second = scheduleUpdatePreview(update);

  assert.equal(first.digest, second.digest);
  assert.equal(applyScheduleUpdate(update), "Updated digest-read interval to 12m.");
});

test("config seeding preserves runtime schedule controls", () => {
  const name = `seed-preserve-${Date.now()}`;
  seedScheduledJobsFromConfig([
    {
      name,
      label: "Initial label",
      command: "test.read",
      intervalMinutes: 5,
      enabled: true,
      delivery: "telegram",
      notifyOnChangeOnly: true,
    },
  ], catalog(__dirname));

  updateScheduledJobState({
    name,
    enabled: false,
    intervalMinutes: 17,
    delivery: "silent",
    nextRunAt: null,
  });
  seedScheduledJobsFromConfig([
    {
      name,
      label: "Updated label",
      command: "test.read",
      intervalMinutes: 60,
      enabled: true,
      delivery: "telegram",
      notifyOnChangeOnly: false,
    },
  ], catalog(__dirname));

  const row = getScheduledJob(name);
  assert.equal(row.label, "Updated label");
  assert.equal(row.interval_minutes, 17);
  assert.equal(row.enabled, 0);
  assert.equal(row.delivery, "silent");
  assert.equal(row.notify_on_change_only, 1);
  assert.equal(row.next_run_at, null);
});

test("change-only delivery suppresses duplicate successful notification", async (t) => {
  const root = workspace(t);
  const name = `change-only-${Date.now()}`;
  const check = {
    ...normalizeScheduledCheck(
      { name, command: "test.read", intervalMinutes: 5, notifyOnChangeOnly: true },
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
