// Browser action policy context must carry the REAL session/run ids (from
// PreparedToolCall.audit), not the old "sess-1"/"run-1" placeholders, so a browser
// confirmation grant is attributed to the actual run. Covers:
//   - buildBrowserActionPolicyContext threads audit ids (fallback "default").
//   - the gateway stores the real ids when it creates a browser confirmation grant.
//
// AGENT_DB_FILE must be set before any dist require (the gateway emits audit records
// to the trace_events table). Each test file runs in its own node --test subprocess.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-grant-ids-"));
process.env.AGENT_DB_FILE = path.join(dbDir, "test.sqlite");

const { buildBrowserActionPolicyContext } = require("../dist/tools/executor");
const { ToolGateway } = require("../dist/tools/gateway");
const { browserConfirmationStore } = require("../dist/security/browser-confirmation");
const { refStore } = require("../dist/browser/ref-store");
const { closeDb } = require("../dist/storage/db");

test.after(() => {
  closeDb();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test("buildBrowserActionPolicyContext threads audit session/run ids (fallback 'default')", () => {
  const args = {
    action: "act",
    profile: "p1",
    targetId: "t1",
    request: { kind: "click", ref: "e1", snapshotId: "snap-x" },
  };

  const audited = buildBrowserActionPolicyContext(args, "browser.act", {
    traceId: "tr",
    sessionId: "real-s",
    runId: "real-r",
    toolCallId: "tc_1",
  });
  assert.equal(audited.sessionId, "real-s");
  assert.equal(audited.runId, "real-r");

  // Without an audit context (e.g. the preview-only call in ToolExecutor.prepare)
  // it falls back to "default" rather than a placeholder.
  const noAudit = buildBrowserActionPolicyContext(args, "browser.act");
  assert.equal(noAudit.sessionId, "default");
  assert.equal(noAudit.runId, "default");
});

test("gateway stores the real session/run ids on a browser confirmation grant", () => {
  // Seed the ref store so the action resolves a consequential element ("Send
  // Message"); the default production policy (consequentialActions: "confirm")
  // then returns "confirm", which is the branch that calls createGrant.
  const snapshotId = refStore.createSnapshot("t1", "p1", "http://example.com");
  refStore.saveRef(snapshotId, "e1", { role: "button", name: "Send Message" });
  try {
    const gateway = new ToolGateway();

    // Capture the input the gateway passes to createGrant.
    let captured;
    const origCreate = browserConfirmationStore.createGrant;
    browserConfirmationStore.createGrant = (input) => {
      captured = input;
      return origCreate.call(browserConfirmationStore, input);
    };
    try {
      const prepared = gateway.prepareRaw(
        {
          name: "browser",
          arguments: {
            action: "act",
            profile: "p1",
            targetId: "t1",
            request: { kind: "click", ref: "e1", snapshotId },
          },
        },
        "tr_browser_ids",
      );
      // Real ids are attached by the tool loop / runtime before authorize; emulate that.
      prepared.audit = {
        traceId: "tr_browser_ids",
        sessionId: "real-s",
        runId: "real-r",
        toolCallId: "tc_browser",
      };
      const authorized = gateway.authorizePrepared(prepared, "chat-1");

      assert.equal(authorized.requiresConfirmation, true, "browser action should require confirmation");
      assert.ok(captured, "createGrant was called");
      assert.equal(captured.sessionId, "real-s");
      assert.equal(captured.runId, "real-r");
      assert.notEqual(captured.sessionId, "sess-1");
      assert.notEqual(captured.runId, "run-1");
    } finally {
      browserConfirmationStore.createGrant = origCreate;
    }
  } finally {
    refStore.clear("t1");
  }
});
