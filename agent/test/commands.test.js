const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const os = require("node:os");

const {
  buildCommandCatalog,
  buildCommandEnvironment,
  loadCommands,
  previewCommand,
  resolveCwd,
  runTrackedCommand,
} = require("../dist/commands");
const { ContextHydrator } = require("../dist/context/hydrator");
const { Router } = require("../dist/core/router");
const { SkillRegistry } = require("../dist/skills/registry");
const {
  deletePendingConfirmation,
  getPendingConfirmation,
  getLastCommandRun,
  listTraceEvents,
  upsertPendingConfirmation,
} = require("../dist/storage/repositories");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");

test("loadCommands maps command names and aliases from allowlist", () => {
  const commands = loadCommands();

  assert.deepEqual(commands["bemo.checkout"].argv, ["npm", "run", "-s", "checkout"]);
  assert.equal(commands["/bemo_checkout"].name, "bemo.checkout");
  assert.equal(commands["/bemo_run"].requiresConfirmation, true);
  assert.deepEqual(commands["shutdown"].argv, ["systemctl", "poweroff"]);
  assert.equal(commands["/shutdown"].name, "shutdown");
  assert.equal(commands["/shutdown"].requiresConfirmation, true);
});

test("configured command cwd resolves to an existing skill directory", () => {
  const commands = loadCommands();
  const bemoCwd = resolveCwd(commands["bemo.checkout"].cwd);

  assert.equal(path.basename(bemoCwd), "bemo");
  assert.equal(fs.existsSync(path.join(bemoCwd, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(bemoCwd, "package.json")), true);
});

test("Router shows an argv command preview before confirmation", async () => {
  const chatId = `test-preview-${Date.now()}`;
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const reply = await router.route({
    traceId: `test-preview-trace-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "test-user",
    text: "/bemo_checkout",
    timestamp: new Date(),
  });

  assert.match(reply, /Executable: npm/);
  assert.match(reply, /Args: \["run","-s","checkout"\]/);
  assert.match(reply, /Cwd: .*skills\/bemo/);
  assert.match(reply, /confirm bemo\.checkout/);
  assert.ok(getPendingConfirmation(chatId));
  deletePendingConfirmation(chatId);
});

test("SQLite schema initializes and traced command runs persist", async () => {
  const traceId = `test_${Date.now()}`;
  const result = await runTrackedCommand({
    traceId,
    chatId: "test-chat",
    action: {
      name: "test.success",
      label: "Test tracked success",
      argv: [process.execPath, "-e", 'process.stdout.write("tracked-ok")'],
      requiresConfirmation: false,
    },
    defaultTimeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  const last = getLastCommandRun();
  assert.equal(last.trace_id, traceId);
  assert.equal(last.status, "success");
  assert.match(last.output_tail, /tracked-ok/);

  const events = listTraceEvents(traceId, 20).map((event) => event.event);
  assert.ok(events.includes("command.started"));
  assert.ok(events.includes("command.completed"));
});

test("tracked command preserves non-zero exit code and stderr output", async () => {
  const result = await runTrackedCommand({
    traceId: `test-failure-${Date.now()}`,
    chatId: "test-chat",
    action: {
      name: "test.failure",
      label: "Test tracked failure",
      argv: [process.execPath, "-e", 'process.stderr.write("agent-fail"); process.exit(7)'],
      requiresConfirmation: false,
    },
    defaultTimeoutMs: 5000,
  });

  assert.equal(result.exitCode, 7);
  assert.match(result.output, /agent-fail/);
});

test("permission policy applies deny precedence and canonical root checks", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-"));
  const workspace = path.join(tmp, "workspace");
  const writable = path.join(workspace, "notes");
  const outside = path.join(tmp, "outside");
  fs.mkdirSync(writable, { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(workspace, "escape"));

  const policy = new PermissionPolicy({
    workspaceRoot: workspace,
    allowedReadRoots: [workspace],
    allowedWriteRoots: [writable],
    deniedPaths: [],
  });

  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, "README.md") }).outcome, "allow");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, ".env") }).reasonCode, "DENIED_PATH");
  assert.equal(policy.evaluate({ kind: "file.write", path: path.join(writable, "new.md") }).outcome, "confirm");
  assert.equal(
    policy.evaluate(
      { kind: "file.write", path: path.join(writable, "new.md") },
      { confirmationGranted: true },
    ).outcome,
    "allow",
  );
  assert.equal(policy.evaluate({ kind: "file.write", path: path.join(workspace, "other.md") }).reasonCode, "OUTSIDE_WRITE_ROOTS");
  assert.equal(policy.evaluate({ kind: "file.write", path: path.join(workspace, "escape", "new.md") }).reasonCode, "OUTSIDE_WORKSPACE");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, ".git", "config") }).reasonCode, "DENIED_PATH");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, "node_modules", "pkg") }).reasonCode, "DENIED_PATH");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(workspace, "credentials.json") }).reasonCode, "DENIED_PATH");
  assert.equal(policy.evaluate({ kind: "file.read", path: path.join(outside, "note.md") }).reasonCode, "OUTSIDE_READ_ROOTS");
  assert.equal(
    policy.evaluate({
      kind: "command.run",
      commandId: "external.write",
      executable: "example",
      args: [],
      cwd: workspace,
      requiresConfirmation: false,
      externalSideEffect: true,
    }).reasonCode,
    "CONFIRMATION_REQUIRED",
  );
});

test("tracked commands cannot bypass policy or confirmation", async () => {
  await assert.rejects(
    runTrackedCommand({
      traceId: `test-policy-cwd-${Date.now()}`,
      chatId: "test-chat",
      action: {
        name: "test.outside",
        label: "Outside workspace",
        cwd: os.tmpdir(),
        argv: [process.execPath, "-e", 'process.stdout.write("must-not-run")'],
        requiresConfirmation: false,
      },
    }),
    /OUTSIDE_WORKSPACE/,
  );

  await assert.rejects(
    runTrackedCommand({
      traceId: `test-policy-confirm-${Date.now()}`,
      chatId: "test-chat",
      action: {
        name: "test.confirm",
        label: "Needs confirmation",
        argv: [process.execPath, "-e", 'process.stdout.write("must-not-run")'],
        requiresConfirmation: true,
      },
    }),
    /CONFIRMATION_REQUIRED/,
  );
});

test("permission policy requires every write root to be readable", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-policy-roots-"));
  const readable = path.join(tmp, "readable");
  const writable = path.join(tmp, "writable");
  fs.mkdirSync(readable);
  fs.mkdirSync(writable);

  assert.throws(
    () =>
      new PermissionPolicy({
        workspaceRoot: tmp,
        allowedReadRoots: [readable],
        allowedWriteRoots: [writable],
        deniedPaths: [],
      }),
    /write root must be contained by an allowed read root/,
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("pending confirmation can expire after 2 minutes", () => {
  const chatId = `test-chat-${Date.now()}`;
  upsertPendingConfirmation({
    chatId,
    traceId: "trace-confirm",
    commandName: "test.confirm",
    payload: { ok: true },
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });

  const pending = getPendingConfirmation(chatId);
  assert.equal(pending.command_name, "test.confirm");
  assert.equal(pending.expires_at <= new Date().toISOString(), true);
  deletePendingConfirmation(chatId);
});

test("new pending confirmation replaces old pending confirmation", () => {
  const chatId = `test-chat-replace-${Date.now()}`;
  upsertPendingConfirmation({
    chatId,
    traceId: "trace-old",
    commandName: "test.old",
    payload: { old: true },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  upsertPendingConfirmation({
    chatId,
    traceId: "trace-new",
    commandName: "test.new",
    payload: { new: true },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const pending = getPendingConfirmation(chatId);
  assert.equal(pending.command_name, "test.new");
  assert.equal(pending.trace_id, "trace-new");
  deletePendingConfirmation(chatId);
});

test("command preview exposes fixed argv, cwd, timeout, and risk", () => {
  const preview = previewCommand({
    name: "test.preview",
    label: "Preview",
    argv: ["node", "script.js", "hello world"],
    cwd: ".",
    timeoutMs: 1234,
    requiresConfirmation: true,
    externalSideEffect: true,
  });

  assert.equal(preview.executable, "node");
  assert.deepEqual(preview.args, ["script.js", "hello world"]);
  assert.equal(preview.cwd, path.resolve(__dirname, ".."));
  assert.equal(preview.timeoutMs, 1234);
  assert.equal(preview.externalSideEffect, true);
});

test("command runner does not interpret shell metacharacters", async (t) => {
  const marker = path.join(os.tmpdir(), `agent-shell-marker-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const literal = `$(touch ${marker})`;
  const result = await runTrackedCommand({
    traceId: `test-no-shell-${Date.now()}`,
    chatId: "test-chat",
    action: {
      name: "test.no-shell",
      label: "No shell",
      argv: [process.execPath, "-e", "process.stdout.write(process.argv[1])", literal],
      requiresConfirmation: false,
    },
  });

  assert.equal(result.output, literal);
  assert.equal(fs.existsSync(marker), false);
});

test("command runner times out with a stable non-zero result", async () => {
  const result = await runTrackedCommand({
    traceId: `test-timeout-${Date.now()}`,
    chatId: "test-chat",
    action: {
      name: "test.timeout",
      label: "Timeout",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 5000)"],
      requiresConfirmation: false,
      timeoutMs: 20,
    },
  });

  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
});

test("minimal command environment excludes undeclared values", () => {
  const env = buildCommandEnvironment({
    PATH: "/test/bin",
    HOME: "/test/home",
    TELEGRAM_BOT_TOKEN: "secret",
    BACKLOG_API_KEY: "secret",
  });

  assert.deepEqual(env, { PATH: "/test/bin", HOME: "/test/home" });
});

test("command catalog fails fast for stale cwd and duplicate aliases", () => {
  assert.throws(
    () => buildCommandCatalog({
      allow: [{
        name: "stale",
        label: "Stale",
        cwd: path.join(os.tmpdir(), `missing-${Date.now()}`),
        argv: ["node"],
      }],
    }),
    /stale cwd/,
  );

  assert.throws(
    () => buildCommandCatalog({
      allow: [
        { name: "one", label: "One", aliases: ["/same"], argv: ["node"] },
        { name: "two", label: "Two", aliases: ["/same"], argv: ["node"] },
      ],
    }),
    /Duplicate command name or alias/,
  );
});

test("ContextHydrator respects dynamic context budget marker", () => {
  const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));
  const hydrator = new ContextHydrator(registry);
  const context = {
    message: {
      traceId: "trace-context",
      provider: "telegram",
      chatId: "chat",
      userId: "user",
      text: "bemo lỗi vừa rồi",
      timestamp: new Date(),
    },
    recentChat: [],
    skillMetadata: registry.listSkills(),
    selectedSkillContent: "x".repeat(30 * 1024),
    allowedCommands: [],
  };

  assert.match(hydrator.toPromptSections(context), /\[truncated: dynamic context exceeded 24KB\]/);
});

test("SkillRegistry rejects skills missing description", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-skill-"));
  fs.mkdirSync(path.join(tmp, "bad"));
  fs.writeFileSync(path.join(tmp, "bad", "SKILL.md"), "---\nname: Bad\n---\n# Bad\n");

  assert.throws(() => new SkillRegistry(tmp), /missing description/);
});
