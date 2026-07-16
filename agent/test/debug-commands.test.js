const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const {
  formatLastCommandError,
  formatLastRun,
  formatToolError,
  handleDebugCommand,
  isDebugCommand,
} = require("../dist/core/debugCommands");
const { insertTraceEvent, listTraceEvents } = require("../dist/storage/repositories");
const { SkillRegistry } = require("../dist/skills/registry");

const registry = new SkillRegistry(path.join(__dirname, "..", "..", "skills"));

test("debug command parser recognizes every built-in command", () => {
  for (const command of [
    "/status",
    "/last",
    "/last-error",
    "/debug",
    "/debug trace-123",
    "/commands",
    "/schedule",
    "/skills",
    "/desktop",
    "/help",
    "help",
  ]) {
    assert.equal(isDebugCommand(command), true, command);
  }
  assert.equal(isDebugCommand("/unknown"), false);
});

test("status, help, command, and skill output include required fields", () => {
  const status = handleDebugCommand("/status", registry);
  assert.match(status, /uptime:/);
  assert.match(status, /current:/);
  assert.match(status, /model:/);
  assert.match(status, /pending approvals:/);
  assert.match(status, /loaded commands: \d+/);
  assert.match(status, new RegExp(`loaded skills: ${registry.listSkills().length}`));

  const commands = handleDebugCommand("/commands", registry);
  assert.match(commands, /bemo/);
  assert.match(commands, /general/);
  assert.match(commands, /bemo\.checkout/);

  const schedule = handleDebugCommand("/schedule", registry);
  assert.match(schedule, /bemo-late/);

  const skills = handleDebugCommand("/skills", registry);
  assert.match(skills, /bemo/);
  assert.match(skills, /gmail/);
  assert.match(skills, /linux-janitor/);

  const desktop = handleDebugCommand("/desktop", registry);
  assert.match(desktop, /platform:/);
  assert.match(desktop, /screen\.capture: (available|unavailable) \((granted|unavailable)\)/);
  assert.match(desktop, /declared apps: \d+/);

  const help = handleDebugCommand("/help", registry);
  assert.match(help, /\/last-error/);
  assert.match(help, /\/stop/);
  assert.match(help, /\/schedule/);
  assert.match(help, /\/desktop/);
  assert.match(help, /Command aliases:/);
  assert.equal(handleDebugCommand("/debug", registry), "Usage: /debug <traceId>");
});

test("last command and error formatters include traceable evidence", () => {
  const run = {
    trace_id: "trace-command",
    status: "failed",
    label: "Fake command",
    finished_at: "2026-07-06T00:00:00.000Z",
    exit_code: 7,
    output_tail: "failure tail",
    error_message: "Exit 7",
  };
  assert.match(formatLastRun(run), /FAILED Fake command/);
  assert.match(formatLastRun(run), /traceId: trace-command/);
  assert.match(formatLastCommandError(run), /error: Exit 7/);
  assert.equal(formatLastRun(null), "No command runs yet.");
});

test("debug trace and tool-error formatting read structured trace events", () => {
  const traceId = `debug-tool-${Date.now()}`;
  insertTraceEvent(traceId, "file.failed", { code: "IO_ERROR", path: "/safe/path" });
  const event = listTraceEvents(traceId, 1)[0];

  assert.match(formatToolError(event), /FAILED TOOL file\.failed/);
  assert.match(formatToolError(event), /IO_ERROR/);
  const debug = handleDebugCommand(`/debug ${traceId}`, registry);
  assert.match(debug, new RegExp(traceId));
  assert.match(debug, /file\.failed/);
});
