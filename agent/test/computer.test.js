const assert = require("node:assert/strict");
const test = require("node:test");

const { DesktopRegistry } = require("../dist/tools/computer/apps");
const { scrotScreenshotArgs, xdotoolWindowSearchArgs, LinuxX11DesktopAdapter, UnavailableDesktopAdapter } = require("../dist/tools/computer/linux-x11");
const { logDesktopEvent } = require("../dist/tools/computer/events");
const { COMPUTER_FRAME_TTL_MS, COMPUTER_CONTROL_LEASE_TTL_MS, ComputerController, ComputerFrameStore, xdotoolArgs } = require("../dist/tools/computer/computer-tool");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { listTraceEvents } = require("../dist/storage/repositories");

function policy() {
  return new PermissionPolicy({
    workspaceRoot: process.cwd(),
    allowedReadRoots: [process.cwd()],
    allowedWriteRoots: [process.cwd()],
    deniedPaths: [],
    desktopAppIds: ["org.example.notes"],
  });
}

const grantedStatus = {
  platform: process.platform,
  capabilities: [
    { capability: "screen.capture", available: true, permission: { state: "granted" } },
    { capability: "app.launch", available: true, permission: { state: "granted" } },
    { capability: "ui.observe", available: true, permission: { state: "granted" } },
    { capability: "ui.act", available: true, permission: { state: "granted" } },
  ],
  displays: [{ id: "display-1", width: 1920, height: 1080, scaleFactor: 1 }],
};

test("desktop registry validates declared app IDs", () => {
  const registry = new DesktopRegistry([{ id: "org.example.notes", label: "Notes" }]);
  assert.equal(registry.get("org.example.notes").label, "Notes");
  assert.equal(registry.resolve("notes").id, "org.example.notes");
  assert.equal(registry.resolve("org.example.notes").id, "org.example.notes");
  assert.equal(registry.resolve("not configured"), undefined);
  assert.throws(() => new DesktopRegistry([{ id: "Notes App", label: "Notes" }]), /Invalid desktop app ID/);
});

test("Linux X11 adapter stays unavailable without a display instead of guessing capture", () => {
  const previousType = process.env.XDG_SESSION_TYPE;
  const previousDisplay = process.env.DISPLAY;
  const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.XDG_SESSION_TYPE = "x11";
  delete process.env.DISPLAY;
  try {
    const adapter = new LinuxX11DesktopAdapter();
    assert.equal(adapter.getStatus().capabilities.find((entry) => entry.capability === "screen.capture").available, false);
  } finally {
    if (previousType === undefined) delete process.env.XDG_SESSION_TYPE; else process.env.XDG_SESSION_TYPE = previousType;
    if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
    if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
  }
});

test("Linux X11 capture command is fixed and contains no user-controlled shell text", () => {
  assert.deepEqual(scrotScreenshotArgs("/tmp/screen.png"), ["-o", "/tmp/screen.png"]);
  assert.deepEqual(xdotoolWindowSearchArgs("Visual Studio Code (1)"), ["search", "--onlyvisible", "--name", "^Visual Studio Code \\(1\\)$"]);
});

test("computer input is bound to a short-lived frame for the same chat and display", () => {
  const frames = new ComputerFrameStore();
  const now = Date.now();
  const { frameId } = frames.issue("chat-a", ":0", now);
  frames.assertCurrent(frameId, "chat-a", now + 1);
  assert.throws(() => frames.assertCurrent(frameId, "chat-b", now + 1), /most recent screenshot frame/);
  assert.throws(() => frames.assertCurrent(frameId, "chat-a", now + COMPUTER_FRAME_TTL_MS), /most recent screenshot frame/);
});

test("computer input compiles to fixed xdotool argv without a shell", () => {
  assert.deepEqual(xdotoolArgs({ action: "left_click", frameId: "frame", x: 10, y: 20 }), ["mousemove", "--sync", "10", "20", "click", "1"]);
  assert.deepEqual(xdotoolArgs({ action: "type", text: "hello" }), ["type", "--clearmodifiers", "--", "hello"]);
  assert.throws(() => xdotoolArgs({ action: "key", key: "ctrl+alt+Delete;rm" }), /invalid/);
});

test("computer controller invalidates a frame before a local input effect", async () => {
  const controller = new ComputerController();
  const { frameId } = controller.observe("chat-a", ":0");
  const input = { action: "left_click", frameId, x: 10, y: 20 };
  await assert.rejects(controller.runInput(input, "chat-a", async () => undefined), /focused target/);
  controller.bindTarget("chat-a", ":0");
  await controller.runInput(input, "chat-a", async () => undefined);
  await assert.rejects(controller.runInput(input, "chat-a", async () => undefined), /most recent screenshot frame/);
  await controller.runInput({ action: "key", key: "ctrl+s" }, "chat-a", async () => undefined);
});

test("computer screenshot alone never authorizes input into an arbitrary app", async () => {
  const controller = new ComputerController();
  const { frameId } = controller.observe("chat-a", ":0");
  await assert.rejects(
    controller.runInput({ action: "left_click", frameId, x: 10, y: 20 }, "chat-a", async () => undefined),
    /focused target/,
  );
});

test("computer control lease is bounded by time and action count", () => {
  const controller = new ComputerController();
  const now = Date.now();
  controller.grantLease("chat-a", now);
  assert.equal(controller.hasLease("chat-a", now + 1), true);
  assert.equal(controller.consumeLease("chat-a", now + 1), true);
  assert.equal(controller.hasLease("chat-a", now + COMPUTER_CONTROL_LEASE_TTL_MS), false);
});

test("desktop actions deny unavailable capabilities and default allow ordinary granted automation", () => {
  const unavailable = new UnavailableDesktopAdapter().getStatus();
  assert.equal(policy().evaluate({ kind: "desktop.capture" }, { desktopStatus: unavailable }).reasonCode, "DESKTOP_CAPABILITY_UNAVAILABLE");
  assert.equal(policy().evaluate({ kind: "desktop.capture", displayId: "display-1" }, { desktopStatus: grantedStatus }).outcome, "allow");
  assert.equal(policy().evaluate({ kind: "desktop.capture", displayId: "unknown" }, { desktopStatus: grantedStatus }).reasonCode, "UNKNOWN_DISPLAY");
  assert.equal(policy().evaluate({ kind: "desktop.launch", appId: "org.example.other" }, { desktopStatus: grantedStatus }).reasonCode, "UNDECLARED_DESKTOP_APP");
  assert.equal(policy().evaluate({ kind: "desktop.launch", appId: "org.example.notes" }, { desktopStatus: grantedStatus }).outcome, "allow");
});

test("desktop events use the shared trace event store", () => {
  const traceId = `desktop-event-${Date.now()}`;
  logDesktopEvent(traceId, {
    component: "desktop",
    action: "screen.capture",
    outcome: "denied",
    reasonCode: "DESKTOP_CAPABILITY_UNAVAILABLE",
  });
  const event = listTraceEvents(traceId, 1)[0];
  assert.equal(event.event, "desktop.screen.capture.denied");
  assert.deepEqual(JSON.parse(event.payload_json), {
    component: "desktop",
    action: "screen.capture",
    outcome: "denied",
    reasonCode: "DESKTOP_CAPABILITY_UNAVAILABLE",
  });
});
