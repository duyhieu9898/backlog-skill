const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserConfirmationStore } = require("../dist/security/browser-confirmation");
const { refStore } = require("../dist/browser/ref-store");

test("browser confirmation lifecycle", () => {
  const store = new BrowserConfirmationStore();

  const grant = store.createGrant({
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
    ttlMs: 1000, // 1 second
  });

  assert.ok(grant.id.startsWith("conf_"));

  // 1. Success matching
  const verify1 = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });
  assert.equal(verify1.valid, true);

  // 2. Consumed grant cannot be reused
  const verify2 = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });
  assert.equal(verify2.valid, false);
  assert.equal(verify2.code, "CONFIRMATION_ALREADY_USED");
});

test("browser confirmation expiration", async () => {
  const store = new BrowserConfirmationStore();

  const grant = store.createGrant({
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
    ttlMs: 5, // 5 milliseconds
  });

  await new Promise((resolve) => setTimeout(resolve, 10));

  const verify = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });
  assert.equal(verify.valid, false);
  assert.equal(verify.code, "CONFIRMATION_EXPIRED");
});

test("browser confirmation validation errors", () => {
  const store = new BrowserConfirmationStore();

  const grant = store.createGrant({
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });

  // Wrong targetId
  const v1 = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-2",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });
  assert.equal(v1.valid, false);
  assert.equal(v1.code, "CONFIRMATION_MISMATCH");

  // Wrong snapshotId (stale snapshot)
  const v2 = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-2",
    actionFingerprint: "fingerprint-123",
  });
  assert.equal(v2.valid, false);
  assert.equal(v2.code, "CONFIRMATION_STALE");

  // Wrong fingerprint
  const v3 = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-456",
  });
  assert.equal(v3.valid, false);
  assert.equal(v3.code, "CONFIRMATION_MISMATCH");
});

test("browser confirmation tab invalidation", () => {
  const store = new BrowserConfirmationStore();

  const grant = store.createGrant({
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });

  store.invalidateForTab("default", "tab-1");

  const verify = store.verifyAndConsume(grant.id, {
    sessionId: "sess-1",
    runId: "run-1",
    profile: "default",
    targetId: "tab-1",
    snapshotId: "snap-1",
    actionFingerprint: "fingerprint-123",
  });
  assert.equal(verify.valid, false);
  assert.equal(verify.code, "CONFIRMATION_ALREADY_USED");
});

test("browser confirmation is stale after navigation even when snapshotId matches", () => {
  const store = new BrowserConfirmationStore();
  const targetId = `tab-rebind-${Date.now()}`;
  const profile = "default";
  const snapshotId = refStore.createSnapshot(targetId, profile, "https://a.test");

  store.createGrant({
    sessionId: "sess-1",
    runId: "run-1",
    profile,
    targetId,
    snapshotId,
    actionFingerprint: "fp-1",
  });

  // Simulate navigation: bumps the tab's document generation. The snapshotId
  // string is unchanged, so the snapshotId check alone would pass — the
  // generation gate is what catches the post-navigation grant (US-027).
  refStore.bumpGeneration(targetId);

  const result = store.findAndConsume({
    sessionId: "sess-1",
    runId: "run-1",
    profile,
    targetId,
    snapshotId,
    actionFingerprint: "fp-1",
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, "CONFIRMATION_STALE");

  refStore.clear(targetId);
});
