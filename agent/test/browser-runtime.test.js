const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
process.env.ALLOW_DATA_URLS = "true";

const { browserService } = require("../dist/browser/browser-service");

test("BrowserService starts, opens tabs, lists, screenshots, and stops", async () => {
  const profileName = "test-agent";
  let tab = null;
  let artifactPath = null;

  try {
    // 1. Start browser
    console.log("Starting browser...");
    const startResult = await browserService.start(profileName);
    assert.equal(startResult.running, true);
    assert.equal(startResult.profile, profileName);
    console.log("Browser started successfully.");

    // 2. Open a tab using a local data URL to avoid network dependency
    console.log("Opening tab...");
    const dataUrl = "data:text/html,<html><head><title>Test Page</title></head><body><h1>Hello World</h1></body></html>";
    tab = await browserService.open(profileName, dataUrl);
    
    assert.ok(tab.targetId);
    assert.match(tab.url, /^data:text\/html/);
    assert.equal(tab.title, "Test Page");
    assert.equal(tab.active, true);
    console.log("Tab opened: ", tab.targetId);

    // 3. List tabs and verify titles
    console.log("Listing tabs...");
    const tabs = await browserService.listTabs(profileName);
    assert.equal(tabs.length, 1);
    assert.equal(tabs[0].targetId, tab.targetId);
    assert.equal(tabs[0].title, "Test Page");

    // 4. Take a screenshot and check artifact generation
    console.log("Taking screenshot...");
    const artifact = await browserService.screenshot(profileName, tab.targetId, {
      fullPage: false,
      chatId: "test-chat-id",
      traceId: "test-trace-id",
    });

    assert.ok(artifact.id);
    assert.equal(artifact.type, "image");
    assert.equal(artifact.mimeType, "image/png");
    assert.ok(fs.existsSync(artifact.path));
    artifactPath = artifact.path;
    console.log("Screenshot saved at: ", artifactPath);

    // 5. Close tab
    console.log("Closing tab...");
    await browserService.close(profileName, tab.targetId);
    tab = null;
    const tabsAfterClose = await browserService.listTabs(profileName);
    assert.equal(tabsAfterClose.length, 0);
    console.log("Tab closed.");

  } catch (error) {
    console.error("TEST_FAILED_WITH_ERROR:", error);
    throw error;
  } finally {
    if (artifactPath && fs.existsSync(artifactPath)) {
      try {
        fs.unlinkSync(artifactPath);
      } catch (err) {
        console.error("Failed to delete screenshot artifact:", err);
      }
    }
    if (tab) {
      try {
        await browserService.close(profileName, tab.targetId);
      } catch (err) {
        console.error("Failed to close tab in finally:", err);
      }
    }
    console.log("Stopping browser...");
    try {
      await browserService.stop(profileName);
      console.log("Browser stopped successfully.");
    } catch (err) {
      console.error("Failed to stop browser in finally:", err);
    }
  }
});
