const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const os = require("node:os");

const {
  buildCommandCatalog,
  buildCommandEnvironment,
  commandPreviewDigest,
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
  insertChatMessage,
  listRecentCommandRuns,
  listTraceEvents,
  upsertPendingConfirmation,
} = require("../dist/storage/repositories");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");

test("loadCommands maps command names and aliases from allowlist", () => {
  const commands = loadCommands();

  assert.deepEqual(commands["bemo.checkout"].argv, ["npm", "run", "-s", "checkout"]);
  assert.equal(commands["/bemo_checkout"].name, "bemo.checkout");
  assert.deepEqual(commands["bemo.late-list"].argv, ["node", "src/workflows/late-timeoff.js", "list"]);
  assert.equal(commands["/bemo_late"].requiresConfirmation, false);
  assert.deepEqual(commands["bemo.create-timeoff"].argv, [
    "node",
    "src/workflows/late-timeoff.js",
    "create",
  ]);
  assert.equal(commands["bemo.create-timeoff"].requiresConfirmation, true);
  assert.equal(commands["bemo.prepare-timeoff"].inputMode, "json-stdin");
  assert.equal(commands["/bemo_checkout"].requiresConfirmation, true);
  assert.equal(commands["/bemo_checkout"].externalSideEffect, true);
  assert.equal(commands["/bemo_run"].requiresConfirmation, true);
  assert.equal(commands["/bemo_run"].externalSideEffect, true);
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
    text: "/shutdown",
    timestamp: new Date(),
  });

  assert.match(reply, /Executable: systemctl/);
  assert.match(reply, /Args: \["poweroff"\]/);
  assert.match(reply, /Cwd: /);
  assert.match(reply, /Approval: [a-f0-9]{12}/);
  assert.match(reply, /confirm shutdown [a-f0-9]{12}/);
  assert.ok(getPendingConfirmation(chatId));
  deletePendingConfirmation(chatId);
});

test("Router executes only a confirmation bound to the exact preview digest", async () => {
  const chatId = `test-digest-confirm-${Date.now()}`;
  const action = {
    name: "test.digest",
    label: "Digest-bound command",
    argv: [process.execPath, "-e", 'process.stdout.write("confirmed-ok")'],
    requiresConfirmation: true,
  };
  const preview = previewCommand(action);
  const digest = commandPreviewDigest(preview);
  upsertPendingConfirmation({
    chatId,
    traceId: `test-digest-pending-${Date.now()}`,
    commandName: action.name,
    payload: { action, preview, digest },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const reply = await router.route({
    traceId: `test-digest-confirm-trace-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "test-user",
    text: `confirm ${action.name} ${digest.slice(0, 12)}`,
    timestamp: new Date(),
  });

  assert.match(reply, /confirmed-ok/);
  assert.equal(getPendingConfirmation(chatId), null);
});

test("Router executes confirmation with short confirm aliases and token-only syntax", async () => {
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));

  // 1. Short confirm 'confirm'
  const chatId1 = `test-short-confirm-1-${Date.now()}`;
  const action1 = {
    name: "test.short1",
    label: "Short confirm command 1",
    argv: [process.execPath, "-e", 'process.stdout.write("short-ok-1")'],
    requiresConfirmation: true,
  };
  const preview1 = previewCommand(action1);
  const digest1 = commandPreviewDigest(preview1);
  upsertPendingConfirmation({
    chatId: chatId1,
    traceId: `test-short-pending-1-${Date.now()}`,
    commandName: action1.name,
    payload: { action: action1, preview: preview1, digest: digest1 },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const reply1 = await router.route({
    traceId: `test-short-confirm-trace-1-${Date.now()}`,
    provider: "telegram",
    chatId: chatId1,
    userId: "test-user",
    text: "confirm",
    timestamp: new Date(),
  });
  assert.match(reply1, /short-ok-1/);
  assert.equal(getPendingConfirmation(chatId1), null);

  // 2. Short confirm 'y'
  const chatId2 = `test-short-confirm-2-${Date.now()}`;
  const action2 = {
    name: "test.short2",
    label: "Short confirm command 2",
    argv: [process.execPath, "-e", 'process.stdout.write("short-ok-2")'],
    requiresConfirmation: true,
  };
  const preview2 = previewCommand(action2);
  const digest2 = commandPreviewDigest(preview2);
  upsertPendingConfirmation({
    chatId: chatId2,
    traceId: `test-short-pending-2-${Date.now()}`,
    commandName: action2.name,
    payload: { action: action2, preview: preview2, digest: digest2 },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const reply2 = await router.route({
    traceId: `test-short-confirm-trace-2-${Date.now()}`,
    provider: "telegram",
    chatId: chatId2,
    userId: "test-user",
    text: "y",
    timestamp: new Date(),
  });
  assert.match(reply2, /short-ok-2/);
  assert.equal(getPendingConfirmation(chatId2), null);

  // 3. Token-only confirm 'confirm <token>'
  const chatId3 = `test-short-confirm-3-${Date.now()}`;
  const action3 = {
    name: "test.short3",
    label: "Short confirm command 3",
    argv: [process.execPath, "-e", 'process.stdout.write("short-ok-3")'],
    requiresConfirmation: true,
  };
  const preview3 = previewCommand(action3);
  const digest3 = commandPreviewDigest(preview3);
  upsertPendingConfirmation({
    chatId: chatId3,
    traceId: `test-short-pending-3-${Date.now()}`,
    commandName: action3.name,
    payload: { action: action3, preview: preview3, digest: digest3 },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const reply3 = await router.route({
    traceId: `test-short-confirm-trace-3-${Date.now()}`,
    provider: "telegram",
    chatId: chatId3,
    userId: "test-user",
    text: `confirm ${digest3.slice(0, 12)}`,
    timestamp: new Date(),
  });
  assert.match(reply3, /short-ok-3/);
  assert.equal(getPendingConfirmation(chatId3), null);
});

test("Router rejects mismatched tokens and changed pending actions", async () => {
  const router = new Router(new SkillRegistry(path.join(__dirname, "..", "..", "skills")));
  const action = {
    name: "test.digest-mismatch",
    label: "Digest mismatch",
    argv: [process.execPath, "-e", 'process.stdout.write("must-not-run")'],
    requiresConfirmation: true,
  };
  const preview = previewCommand(action);
  const digest = commandPreviewDigest(preview);
  const mismatchChat = `test-digest-mismatch-${Date.now()}`;
  upsertPendingConfirmation({
    chatId: mismatchChat,
    traceId: "test-digest-mismatch-pending",
    commandName: action.name,
    payload: { action, preview, digest },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });

  const mismatchReply = await router.route({
    traceId: `test-digest-mismatch-trace-${Date.now()}`,
    provider: "telegram",
    chatId: mismatchChat,
    userId: "test-user",
    text: `confirm ${action.name} 000000000000`,
    timestamp: new Date(),
  });
  assert.match(mismatchReply, /không khớp/);
  assert.ok(getPendingConfirmation(mismatchChat));
  deletePendingConfirmation(mismatchChat);

  const changedChat = `test-digest-changed-${Date.now()}`;
  upsertPendingConfirmation({
    chatId: changedChat,
    traceId: "test-digest-changed-pending",
    commandName: action.name,
    payload: {
      action: { ...action, argv: [process.execPath, "-e", 'process.stdout.write("changed")'] },
      preview,
      digest,
    },
    expiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  const changedReply = await router.route({
    traceId: `test-digest-changed-trace-${Date.now()}`,
    provider: "telegram",
    chatId: changedChat,
    userId: "test-user",
    text: `confirm ${action.name} ${digest.slice(0, 12)}`,
    timestamp: new Date(),
  });
  assert.match(changedReply, /action đã thay đổi/);
  assert.equal(getPendingConfirmation(changedChat), null);
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
  const run = listRecentCommandRuns("test-chat", 20).find((row) => row.trace_id === traceId);
  assert.ok(run);
  assert.equal(run.status, "success");
  assert.match(run.output_tail, /tracked-ok/);

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
    prompt: {
      history: [],
      runtime: { currentTime: "2026-07-10T16:35:14", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" },
      selectedSkill: {
        slug: "test",
        name: "Test",
        description: "Test skill",
        instructions: "x".repeat(30 * 1024),
      },
    },
  };

  assert.match(hydrator.toPromptSections(context), /\[truncated: dynamic context exceeded 24KB\]/);
});

test("ContextHydrator builds a minimal, redacted prompt for general conversation", () => {
  const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));
  const hydrator = new ContextHydrator(registry);
  const chatId = `safe-context-${Date.now()}`;
  const currentTraceId = `safe-context-current-${Date.now()}`;
  insertChatMessage({
    chatId,
    userId: "agent",
    role: "assistant",
    content: "Tác vụ cần xác nhận.\nExecutable: systemctl\nArgs: [\"poweroff\"]\nCwd: /private\nApproval: secret-token",
    traceId: "previous-trace",
  });
  insertChatMessage({
    chatId,
    userId: "user",
    role: "user",
    content: "hôm nay là thứ mấy",
    traceId: currentTraceId,
  });

  const prompt = hydrator.hydrate({
    traceId: currentTraceId,
    provider: "telegram",
    chatId,
    userId: "user",
    text: "hôm nay là thứ mấy",
    timestamp: new Date("2026-07-10T18:30:00.000Z"),
  }).prompt;

  assert.deepEqual(prompt.toolScope, undefined);
  assert.equal(prompt.selectedSkill, undefined);
  assert.deepEqual(prompt.runtime, {
    currentTime: "2026-07-11T01:30:00",
    timezone: "Asia/Ho_Chi_Minh",
    locale: "vi-VN",
  });
  assert.equal(prompt.history.length, 1);
  assert.match(prompt.history[0].content, /Tác vụ cần xác nhận/);
  assert.doesNotMatch(prompt.history[0].content, /Executable|Args|Cwd|Approval|secret-token/);
});

test("ContextHydrator isolates desktop requests from stale chat tool protocol", () => {
  const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));
  const chatId = `desktop-context-${Date.now()}`;
  insertChatMessage({ chatId, userId: "user", role: "user", content: "confirm computer deadbeef1234", traceId: "old-confirm" });
  insertChatMessage({ chatId, userId: "agent", role: "assistant", content: '```json\n{"toolCall":{"name":"computer","arguments":{"action":"left_click"}}}\n```', traceId: "old-raw" });
  insertChatMessage({ chatId, userId: "user", role: "user", content: "tạo file cũ", traceId: "old-task" });
  const prompt = new ContextHydrator(registry).hydrate({
    provider: "telegram", chatId, userId: "user", text: "Mở VS Code", traceId: "desktop-now", timestamp: new Date(),
  }).prompt;
  assert.deepEqual(prompt.history, []);
  assert.deepEqual(prompt.toolScope, { includeFileTools: false, desktopOnly: true });
});
