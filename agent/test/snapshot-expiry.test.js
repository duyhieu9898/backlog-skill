const assert = require("node:assert/strict");
const test = require("node:test");
const { refStore } = require("../dist/browser/ref-store");

test("Snapshot expiry and association tracking", () => {
  const profileName = "snap-expiry-profile";
  const targetId = "tab_mock_01";

  // 1. Snapshot TTL expiry behavior
  const snapId = refStore.createSnapshot(targetId, profileName, "https://test.com");
  const record = refStore.getRecord(snapId);
  assert.ok(record);

  // Expiration check is immediate: if expiresAt <= now, it should return undefined
  record.expiresAt = Date.now() - 1000;
  assert.equal(refStore.getRecord(snapId), undefined);

  // 2. Snapshot deletion when its tab closes
  const snapId2 = refStore.createSnapshot(targetId, profileName, "https://test.com");
  assert.ok(refStore.getRecord(snapId2));

  refStore.clear(targetId);
  assert.equal(refStore.getRecord(snapId2), undefined);

  // 3. Profile shutdown removes profile snapshots
  const snapId3 = refStore.createSnapshot(targetId, profileName, "https://test.com");
  assert.ok(refStore.getRecord(snapId3));

  refStore.clearProfile(profileName);
  assert.equal(refStore.getRecord(snapId3), undefined);
});
