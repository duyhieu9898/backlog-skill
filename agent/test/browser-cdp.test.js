const path = require("node:path");
process.env.AGENT_CONFIG_FILE = path.join(__dirname, "config.browser-cdp.json");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { chromium } = require("playwright");

// Enable data URLs navigation for test
process.env.ALLOW_DATA_URLS = "true";

const { loadAgentConfig } = require("../dist/config/app");
const { browserService } = require("../dist/browser/browser-service");
const { configFile } = require("../dist/config/paths");

test("CDP Browser Service", async (t) => {
  let originalConfigContent = "";
  const backupConfig = () => {
    if (fs.existsSync(configFile)) {
      originalConfigContent = fs.readFileSync(configFile, "utf8");
    }
  };

  const restoreConfig = () => {
    if (originalConfigContent) {
      fs.writeFileSync(configFile, originalConfigContent, "utf8");
    } else if (fs.existsSync(configFile)) {
      fs.unlinkSync(configFile);
    }
  };

  // Ensure we back up and restore config
  backupConfig();

  await t.test("Unit: should throw error when CDP profile lacks endpoint", () => {
    try {
      const invalidConfig = {
        ai: { default: "gemini", providers: {} },
        permissions: { workspaceRoot: "..", allowedReadRoots: [], allowedWriteRoots: [], deniedPaths: [] },
        browser: {
          profiles: {
            "bad-cdp": {
              mode: "cdp"
            }
          }
        }
      };
      fs.writeFileSync(configFile, JSON.stringify(invalidConfig), "utf8");

      assert.throws(() => {
        loadAgentConfig();
      }, /CDP profile "bad-cdp" must have an endpoint/);

      // Endpoint is empty string
      invalidConfig.browser.profiles["bad-cdp"].endpoint = "   ";
      fs.writeFileSync(configFile, JSON.stringify(invalidConfig), "utf8");
      assert.throws(() => {
        loadAgentConfig();
      }, /CDP profile "bad-cdp" endpoint must be a non-empty string/);

    } finally {
      restoreConfig();
    }
  });

  await t.test("Integration: starts, attaches over CDP, opens page, and stops", async () => {
    let remoteBrowser = null;
    try {
      // 1. Launch a Chromium browser with remote debugging port enabled
      const port = 12000 + Math.floor(Math.random() * 8000);
      remoteBrowser = await chromium.launch({
        args: [`--remote-debugging-port=${port}`]
      });
      const cdpEndpoint = `http://127.0.0.1:${port}`;

      // 2. Configure the CDP profile with the cdpEndpoint in config.json
      const configData = {
        ai: { default: "gemini", providers: {} },
        permissions: { workspaceRoot: "..", allowedReadRoots: [], allowedWriteRoots: [], deniedPaths: [] },
        browser: {
          profiles: {
            "test-cdp-profile": {
              mode: "cdp",
              endpoint: cdpEndpoint
            }
          }
        }
      };
      fs.writeFileSync(configFile, JSON.stringify(configData), "utf8");

      // Verify config loads without errors
      const loaded = loadAgentConfig();
      assert.equal(loaded.browser.profiles["test-cdp-profile"].mode, "cdp");
      assert.equal(loaded.browser.profiles["test-cdp-profile"].endpoint, cdpEndpoint);

      // 3. Connect browserService over CDP
      const startResult = await browserService.start("test-cdp-profile");
      assert.equal(startResult.running, true);
      assert.equal(startResult.profile, "test-cdp-profile");

      // Verify tabs list is initially empty (or contains default page)
      const initialTabs = await browserService.listTabs("test-cdp-profile");
      assert.ok(Array.isArray(initialTabs));

      // 4. Open a test data URL tab
      const dataUrl = "data:text/html,<html><head><title>CDP Test Page</title></head><body><h1>Hello CDP</h1></body></html>";
      const tab = await browserService.open("test-cdp-profile", dataUrl);

      assert.ok(tab.targetId);
      assert.equal(tab.title, "CDP Test Page");
      assert.match(tab.url, /^data:text\/html/);

      // Verify it appears in active list
      const tabs = await browserService.listTabs("test-cdp-profile");
      const found = tabs.find(t => t.targetId === tab.targetId);
      assert.ok(found);
      assert.equal(found.title, "CDP Test Page");

      // 5. Close tab and stop profile
      await browserService.close("test-cdp-profile", tab.targetId);
      const tabsAfterClose = await browserService.listTabs("test-cdp-profile");
      assert.equal(tabsAfterClose.filter(t => t.targetId === tab.targetId).length, 0);

      await browserService.stop("test-cdp-profile");

      // Ensure registry is cleaned up
      const registry = browserService.getRegistry("test-cdp-profile");
      assert.equal(registry.get("test-cdp-profile"), undefined);

    } finally {
      restoreConfig();
      if (remoteBrowser) {
        await remoteBrowser.close();
      }
    }
  });
});
