const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { ManagedPlaywrightBrowserService } = require("../dist/browser/managed-playwright-service");
const { BrowserCleanupSweeper } = require("../dist/browser/cleanup-sweeper");
const { refStore } = require("../dist/browser/ref-store");

test("BrowserCleanupSweeper sweeps stale tabs, protects busy ones, and enforces quota", async () => {
  const service = new ManagedPlaywrightBrowserService();
  const sweeper = new BrowserCleanupSweeper(service);

  const profileName = "sweeper-test-profile";
  service.getRegistry().register(profileName, {
    name: profileName,
    persistent: true,
    userDataDir: "/tmp/mock-user-dir",
    status: "running",
    activeOperationCount: 0,
    shutdownRequested: false,
    lastUsedAt: Date.now(),
  });

  const tabRegistry = service.getTabRegistry();

  // 1. Test Idle Tab Closure
  const mockPage1 = { url: () => "https://google.com", close: async () => {}, on: () => {} };
  const mockPage2 = { url: () => "https://apple.com", close: async () => {}, on: () => {} };
  const mockPage3 = { url: () => "https://github.com", close: async () => {}, on: () => {} };

  const id1 = tabRegistry.register(mockPage1, {}, profileName);
  const id2 = tabRegistry.register(mockPage2, {}, profileName);
  const id3 = tabRegistry.register(mockPage3, {}, profileName);

  const rec1 = tabRegistry.get(id1, profileName);
  const rec2 = tabRegistry.get(id2, profileName);
  const rec3 = tabRegistry.get(id3, profileName);

  // Set active tab
  tabRegistry.setActive(id1, profileName);

  // Make rec2 stale (threshold is 30 mins = 1800000 ms)
  rec2.lastUsedAt = Date.now() - 31 * 60 * 1000;
  // rec3 is fresh
  rec3.lastUsedAt = Date.now();

  const res1 = await sweeper.sweep();
  assert.deepEqual(res1.closedIdleTabs, [id2]);
  assert.equal(tabRegistry.get(id2, profileName), undefined);
  assert.ok(tabRegistry.get(id1, profileName));
  assert.ok(tabRegistry.get(id3, profileName));

  // 2. Test Busy Tab Protection
  const id4 = tabRegistry.register(mockPage2, {}, profileName);
  const rec4 = tabRegistry.get(id4, profileName);
  rec4.lastUsedAt = Date.now() - 31 * 60 * 1000;
  rec4.activeOperationCount = 1; // Mark as busy

  const res2 = await sweeper.sweep();
  assert.deepEqual(res2.closedIdleTabs, []); // skipped because it is busy
  assert.deepEqual(res2.skippedBusyTabs, [id4]);

  // Make it not busy
  rec4.activeOperationCount = 0;

  // 3. Test Snapshot Expiration
  // Generate snapshots
  const snap1 = refStore.createSnapshot(id1, profileName, "https://google.com");
  const record1 = refStore.getRecord(snap1);
  assert.ok(record1);

  // Manually expire snap1 (snapshotTtlMinutes is 10)
  record1.expiresAt = Date.now() - 1 * 60 * 1000;

  const res3 = await sweeper.sweep();
  assert.deepEqual(res3.deletedSnapshots, [snap1]);
  assert.equal(refStore.getRecord(snap1), undefined);

  // 4. Test Tab Quota Enforcement (Default maxTabsPerProfile = 10)
  // Fill up registry to 11 active tabs
  tabRegistry.clear(profileName);
  const tabIds = [];
  for (let i = 0; i < 11; i++) {
    const page = { url: () => `https://tab-${i}.com`, close: async () => {}, on: () => {} };
    const tabId = tabRegistry.register(page, {}, profileName);
    const rec = tabRegistry.get(tabId, profileName);
    rec.lastUsedAt = Date.now() - (11 - i) * 60000; // oldest is index 0
    tabIds.push(tabId);
  }

  // Set the 11th tab (last one) active
  tabRegistry.setActive(tabIds[10], profileName);

  const res4 = await sweeper.sweep();
  // Quota sweep should close the oldest eligible tab, which is tabIds[0] (the first created/used)
  assert.deepEqual(res4.closedQuotaTabs, [tabIds[0]]);
  assert.equal(tabRegistry.get(tabIds[0], profileName), undefined);
  assert.equal(tabRegistry.getAllRecords().filter(t => t.profile === profileName).length, 10);
});
