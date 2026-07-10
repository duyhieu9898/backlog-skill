const assert = require("node:assert/strict");
const test = require("node:test");

const { DesktopRegistry } = require("../dist/desktop/registry");
const { UnavailableDesktopAdapter } = require("../dist/desktop/adapter");
const { logDesktopEvent } = require("../dist/desktop/events");
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
  assert.throws(() => new DesktopRegistry([{ id: "Notes App", label: "Notes" }]), /Invalid desktop app ID/);
});

test("desktop actions deny unavailable capabilities and require confirmation when granted", () => {
  const unavailable = new UnavailableDesktopAdapter().getStatus();
  assert.equal(policy().evaluate({ kind: "desktop.capture" }, { desktopStatus: unavailable }).reasonCode, "DESKTOP_CAPABILITY_UNAVAILABLE");
  assert.equal(policy().evaluate({ kind: "desktop.capture", displayId: "display-1" }, { desktopStatus: grantedStatus }).outcome, "confirm");
  assert.equal(policy().evaluate({ kind: "desktop.capture", displayId: "unknown" }, { desktopStatus: grantedStatus }).reasonCode, "UNKNOWN_DISPLAY");
  assert.equal(policy().evaluate({ kind: "desktop.launch", appId: "org.example.other" }, { desktopStatus: grantedStatus }).reasonCode, "UNDECLARED_DESKTOP_APP");
  assert.equal(
    policy().evaluate(
      { kind: "desktop.launch", appId: "org.example.notes" },
      { desktopStatus: grantedStatus, confirmationGranted: true },
    ).outcome,
    "allow",
  );
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
