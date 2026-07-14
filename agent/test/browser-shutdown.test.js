const assert = require("node:assert/strict");
const test = require("node:test");
const { ManagedPlaywrightBrowserService } = require("../dist/browser/managed-playwright-service");
const { BrowserError } = require("../dist/browser/errors");

test("BrowserService shutdown is idempotent and rejects new operations", async () => {
  const service = new ManagedPlaywrightBrowserService();

  // Register mock running profile
  const profileName = "shutdown-test-profile";
  let closedCalled = 0;
  
  const mockContext = {
    close: async () => {
      closedCalled++;
    }
  };

  service.getRegistry().register(profileName, {
    name: profileName,
    persistent: true,
    userDataDir: "/tmp/mock-user-dir",
    status: "running",
    context: mockContext,
    activeOperationCount: 0,
    shutdownRequested: false,
    lastUsedAt: Date.now(),
  });

  // Call shutdown
  const result1 = await service.shutdown({ gracefulTimeoutMs: 100, forceKillTimeoutMs: 100 });
  assert.equal(closedCalled, 1);
  assert.deepEqual(result1.closedProfiles, [profileName]);
  assert.equal(service.isShuttingDown(), true);

  // Idempotent check
  const result2 = await service.shutdown({ gracefulTimeoutMs: 100, forceKillTimeoutMs: 100 });
  assert.equal(closedCalled, 1); // Close not called again
  assert.deepEqual(result2, result1);

  // New operations should be rejected
  await assert.rejects(
    async () => {
      await service.start(profileName);
    },
    (err) => err.code === "BROWSER_SHUTTING_DOWN"
  );

  await assert.rejects(
    async () => {
      await service.open(profileName, "https://google.com");
    },
    (err) => err.code === "BROWSER_SHUTTING_DOWN"
  );
});

test("BrowserService shutdown waits for active operations", async () => {
  const service = new ManagedPlaywrightBrowserService();

  const profileName = "shutdown-grace-profile";
  let closedCalled = 0;
  
  const mockContext = {
    close: async () => {
      closedCalled++;
    }
  };

  const registryState = {
    name: profileName,
    persistent: true,
    userDataDir: "/tmp/mock-user-dir-grace",
    status: "running",
    context: mockContext,
    activeOperationCount: 1, // Has active operation
    shutdownRequested: false,
    lastUsedAt: Date.now(),
  };

  service.getRegistry().register(profileName, registryState);

  // Simulate operation finishing after 200ms
  setTimeout(() => {
    registryState.activeOperationCount = 0;
  }, 200);

  const start = Date.now();
  const result = await service.shutdown({ gracefulTimeoutMs: 1000, forceKillTimeoutMs: 100 });
  const duration = Date.now() - start;

  assert.ok(duration >= 200, `Should have waited at least 200ms, waited ${duration}ms`);
  assert.equal(closedCalled, 1);
  assert.deepEqual(result.closedProfiles, [profileName]);
});
