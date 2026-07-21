const assert = require("node:assert/strict");
const test = require("node:test");

const { validateBrowserActionRequest } = require("../dist/browser/types");
const { normalizeActionEnvelope, classifyOutcome, buildRecovery } = require("../dist/browser/contract");

test("browser contract rejects ref actions without their snapshot capability", () => {
  assert.throws(
    () => validateBrowserActionRequest({ kind: "click", ref: "e1" }),
    /requires snapshotId/,
  );
  assert.deepEqual(validateBrowserActionRequest({ kind: "press", key: "Enter" }), { kind: "press", key: "Enter" });
});

test("browser contract rejects every ref kind missing snapshotId", () => {
  for (const kind of ["click", "fill", "type", "select"]) {
    const payload =
      kind === "fill" || kind === "select"
        ? { kind, ref: "e1", value: "v" }
        : kind === "type"
          ? { kind, ref: "e1", text: "t" }
          : { kind, ref: "e1" };
    assert.throws(() => validateBrowserActionRequest(payload), /requires snapshotId/);
  }
});

test("browser contract rejects cross-variant fields", () => {
  // press must not carry ref/snapshotId
  assert.throws(() => validateBrowserActionRequest({ kind: "press", key: "Enter", ref: "e1" }), /does not accept "ref"/);
  // click must not carry key
  assert.throws(() => validateBrowserActionRequest({ kind: "click", ref: "e1", snapshotId: "s1", key: "Enter" }), /does not accept "key"/);
  // scroll must not carry ref
  assert.throws(() => validateBrowserActionRequest({ kind: "scroll", direction: "down", ref: "e1" }), /does not accept "ref"/);
});

test("normalizeActionEnvelope rejects malformed provider envelopes", () => {
  assert.throws(() => normalizeActionEnvelope({ action: "act", request: { kind: "click", ref: "e1" } }), /requires snapshotId/);
  assert.throws(() => normalizeActionEnvelope({ action: "act", request: { kind: "press", key: "Enter", ref: "e1" } }), /does not accept "ref"/);
  assert.throws(() => normalizeActionEnvelope("nope"), /must be an object/);
  const { action, request } = normalizeActionEnvelope({ action: "act", request: { kind: "click", ref: "e1", snapshotId: "snap_1" } });
  assert.equal(action, "act");
  assert.equal(request.kind, "click");
});

test("classifyOutcome sets nextSnapshotRequired for document-changing mutations", () => {
  assert.equal(classifyOutcome({ kind: "click", navigated: true }).nextSnapshotRequired, true);
  assert.equal(classifyOutcome({ kind: "click", majorDomChange: true }).nextSnapshotRequired, true);
  assert.equal(classifyOutcome({ kind: "click", tabReplaced: true }).nextSnapshotRequired, true);
  assert.equal(classifyOutcome({ kind: "click", frameNavigated: true }).nextSnapshotRequired, true);
  const minor = classifyOutcome({ kind: "click" });
  assert.equal(minor.mutationMagnitude, "minor-dom");
  assert.equal(minor.nextSnapshotRequired, false);
  assert.equal(minor.refFreshness, "possibly-stale");
});

test("buildRecovery marks snapshot/ref codes as requiring a new snapshot", () => {
  assert.deepEqual(buildRecovery("SNAPSHOT_STALE_REVISION", "doc changed"), { requiresNewSnapshot: true, reason: "doc changed" });
  assert.equal(buildRecovery("ACTION_FAILED", "boom").requiresNewSnapshot, false);
});
