const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { browserService } = require("../dist/browser/browser-service");

test("browser persistence, isolation, and quotas", async (t) => {
  // Start a local HTTP server to get a real origin for cookies and localStorage
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>Persistence Test</title></head><body><h1>Hello</h1></body></html>");
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const testUrl = `http://localhost:${port}/`;
  console.log("Local HTTP server started at", testUrl);

  const configPath = path.resolve(__dirname, "../config.json");
  let originalConfigStr = null;
  if (fs.existsSync(configPath)) {
    originalConfigStr = fs.readFileSync(configPath, "utf8");
  }

  // Configure allowedHosts in config.json to permit localhost:port
  const originalConfig = originalConfigStr ? JSON.parse(originalConfigStr) : {};
  const testConfig = {
    ...originalConfig,
    permissions: {
      ...originalConfig.permissions,
      browser: {
        ...originalConfig.permissions?.browser,
        allowedHosts: [
          ...(originalConfig.permissions?.browser?.allowedHosts || []),
          `localhost:${port}`
        ]
      }
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf8");
  console.log("Allowed hosts updated in config.json");

  const profileA = "profile-test-a";
  const profileB = "profile-test-b";
  const ephemeralProfileName = "ephemeral-test-profile";
  const quotaProfile = "quota-test-profile";

  try {
    // 1. Profile Isolation Test
    console.log("Starting profile A and B...");
    await browserService.start(profileA);
    await browserService.start(profileB);

    console.log("Opening tabs...");
    const tabA = await browserService.open(profileA, testUrl);
    const tabB = await browserService.open(profileB, testUrl);

    // Set cookie and localStorage in A
    const recordTabA = browserService.getTabRegistry().get(tabA.targetId, profileA);
    const recordTabB = browserService.getTabRegistry().get(tabB.targetId, profileB);

    console.log("Setting storage values in profile A...");
    await recordTabA.page.evaluate(() => {
      document.cookie = "user=alice; expires=Tue, 19 Jan 2038 03:14:07 GMT; path=/";
      localStorage.setItem("key", "value-alice");
    });

    console.log("Reading storage values in profile B...");
    const storageB = await recordTabB.page.evaluate(() => {
      return {
        cookie: document.cookie,
        local: localStorage.getItem("key")
      };
    });

    console.log("Profile B storage content:", storageB);

    assert.equal(storageB.cookie.includes("user=alice"), false);
    assert.equal(storageB.local, null);

    // Set storage in B
    await recordTabB.page.evaluate(() => {
      document.cookie = "user=bob; expires=Tue, 19 Jan 2038 03:14:07 GMT; path=/";
      localStorage.setItem("key", "value-bob");
    });

    // Close both
    console.log("Stopping profiles A and B...");
    await browserService.stop(profileA);
    await browserService.stop(profileB);

    // Restart and verify state persistence
    console.log("Restarting profile A...");
    await browserService.start(profileA);
    const newTabA = await browserService.open(profileA, testUrl);
    const recordNewTabA = browserService.getTabRegistry().get(newTabA.targetId, profileA);

    const storageARestored = await recordNewTabA.page.evaluate(() => {
      return {
        cookie: document.cookie,
        local: localStorage.getItem("key")
      };
    });

    console.log("Profile A restored storage content:", storageARestored);

    assert.ok(storageARestored.cookie.includes("user=alice"));
    assert.equal(storageARestored.local, "value-alice");

    console.log("Stopping profile A...");
    await browserService.stop(profileA);

    // 2. Ephemeral Profile Test
    console.log("Configuring ephemeral profile in config.json...");
    const currentConfigStr = fs.readFileSync(configPath, "utf8");
    const currentConfig = JSON.parse(currentConfigStr);
    currentConfig.browser = currentConfig.browser || {};
    currentConfig.browser.profiles = currentConfig.browser.profiles || {};
    currentConfig.browser.profiles[ephemeralProfileName] = { persistent: false };
    fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2), "utf8");

    console.log("Starting ephemeral profile...");
    await browserService.start(ephemeralProfileName);
    const state = browserService.getRegistry().get(ephemeralProfileName);
    assert.equal(state.persistent, false);
    assert.ok(fs.existsSync(state.userDataDir));

    const ephTab = await browserService.open(ephemeralProfileName, testUrl);
    const recordEphTab = browserService.getTabRegistry().get(ephTab.targetId, ephemeralProfileName);

    await recordEphTab.page.evaluate(() => {
      document.cookie = "user=guest; expires=Tue, 19 Jan 2038 03:14:07 GMT; path=/";
      localStorage.setItem("key", "value-guest");
    });

    const ephDir = state.userDataDir;
    console.log("Stopping ephemeral profile...");
    await browserService.stop(ephemeralProfileName);

    // Assert temporary directory is removed
    assert.equal(fs.existsSync(ephDir), false);

    // 3. Immediate Tab Quota Enforcement
    console.log("Configuring tab quota in config.json...");
    const currentConfigStr2 = fs.readFileSync(configPath, "utf8");
    const currentConfig2 = JSON.parse(currentConfigStr2);
    currentConfig2.browser = currentConfig2.browser || {};
    currentConfig2.browser.cleanup = currentConfig2.browser.cleanup || {};
    currentConfig2.browser.cleanup.maxTabsPerProfile = 3;
    fs.writeFileSync(configPath, JSON.stringify(currentConfig2, null, 2), "utf8");

    console.log("Starting quota profile...");
    await browserService.start(quotaProfile);
    
    console.log("Opening 3 tabs...");
    const t1 = await browserService.open(quotaProfile, testUrl);
    const t2 = await browserService.open(quotaProfile, testUrl);
    const t3 = await browserService.open(quotaProfile, testUrl);

    assert.equal(browserService.getTabRegistry().getAllRecords().filter(t => t.profile === quotaProfile).length, 3);

    console.log("Opening 4th tab (should trigger quota cleanup of t1)...");
    const t4 = await browserService.open(quotaProfile, testUrl);
    assert.equal(browserService.getTabRegistry().getAllRecords().filter(t => t.profile === quotaProfile).length, 3);
    assert.equal(browserService.getTabRegistry().get(t1.targetId, quotaProfile), undefined);
    assert.ok(browserService.getTabRegistry().get(t2.targetId, quotaProfile));
    assert.ok(browserService.getTabRegistry().get(t3.targetId, quotaProfile));
    assert.ok(browserService.getTabRegistry().get(t4.targetId, quotaProfile));

    console.log("Stopping quota profile...");
    await browserService.stop(quotaProfile);

    console.log("All persistence, isolation, and quota tests completed successfully!");

  } catch (err) {
    console.error("Test failed with error:", err);
    throw err;
  } finally {
    console.log("Running finally cleanup...");
    // Restore config
    if (originalConfigStr !== null) {
      fs.writeFileSync(configPath, originalConfigStr, "utf8");
      console.log("Original config.json restored");
    } else {
      try {
        fs.unlinkSync(configPath);
        console.log("Config.json cleaned up");
      } catch (e) {}
    }
    
    try {
      await browserService.stop(profileA);
    } catch(e) {}
    try {
      await browserService.stop(profileB);
    } catch(e) {}
    try {
      await browserService.stop(ephemeralProfileName);
    } catch(e) {}
    try {
      await browserService.stop(quotaProfile);
    } catch(e) {}
    server.close();
    console.log("Finally cleanup completed.");
  }
});
