const assert = require("node:assert/strict");
const test = require("node:test");
process.env.ALLOW_DATA_URLS = "true";

const { browserService } = require("../dist/browser/browser-service");

test("BrowserService snapshot, act, and stale ref fallback resolution", async () => {
  const profileName = "test-actions-agent";

  // Start browser
  await browserService.start(profileName);

  let tab = null;
  try {
    // 1. Open Page A with interactive elements
    const htmlA = `data:text/html,
      <html>
        <head><title>Page A</title></head>
        <body>
          <h1>Heading A</h1>
          <button>Submit Button</button>
          <input type="text" value="initial" />
        </body>
      </html>
    `.replace(/\n/g, "");

    tab = await browserService.open(profileName, htmlA);
    assert.ok(tab.targetId);

    // 2. Generate snapshot
    const snapshotA = await browserService.snapshot(profileName, tab.targetId);
    assert.ok(snapshotA.snapshotId);
    
    // Check that it serialized correctly and assigned refs
    assert.match(snapshotA.text, /heading "Heading A"/);
    assert.match(snapshotA.text, /button "Submit Button" \[ref=e1\]/);
    assert.match(snapshotA.text, /textbox: initial \[ref=e2\]/);

    // 3. Test typing into textbox using ref e2
    const updatedTab = await browserService.act(profileName, tab.targetId, {
      kind: "fill",
      ref: "e2",
      snapshotId: snapshotA.snapshotId,
      value: "hello world"
    });
    
    // Verify that the action succeeded and didn't crash
    assert.equal(updatedTab.targetId, tab.targetId);

    // Take a new snapshot and verify the value has updated
    const snapshotA2 = await browserService.snapshot(profileName, tab.targetId);
    assert.match(snapshotA2.text, /textbox: hello world \[ref=e2\]/);

    // 4. Test Fallback Resolution: Navigate to Page B (same button, makes snapshotA stale)
    const htmlB = `data:text/html,
      <html>
        <head><title>Page B</title></head>
        <body>
          <button>Submit Button</button>
        </body>
      </html>
    `.replace(/\n/g, "");

    await browserService.navigate(profileName, tab.targetId, htmlB);
    
    // We snapshot Page B to update the latest snapshot, making snapshotA stale
    const snapshotB = await browserService.snapshot(profileName, tab.targetId);
    assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId);

    // Clicking using stale snapshotA's ref e1 should succeed because the button is still unique on the page
    const clickedTab = await browserService.act(profileName, tab.targetId, {
      kind: "click",
      ref: "e1",
      snapshotId: snapshotA.snapshotId
    });
    assert.equal(clickedTab.targetId, tab.targetId);

    // 5. Test Fallback Resolution: Navigate to Page C (button is gone, should fail)
    const htmlC = `data:text/html,
      <html>
        <head><title>Page C</title></head>
        <body>
          <p>No buttons here</p>
        </body>
      </html>
    `.replace(/\n/g, "");

    await browserService.navigate(profileName, tab.targetId, htmlC);
    await browserService.snapshot(profileName, tab.targetId);

    // Clicking e1 from snapshotA should now throw ELEMENT_NOT_FOUND
    await assert.rejects(
      async () => {
        await browserService.act(profileName, tab.targetId, {
          kind: "click",
          ref: "e1",
          snapshotId: snapshotA.snapshotId
        });
      },
      (err) => {
        assert.equal(err.code, "ELEMENT_NOT_FOUND");
        return true;
      }
    );

    // 6. Test Fallback Resolution: Navigate to Page D (ambiguous buttons, should throw STALE_ELEMENT_REF)
    const htmlD = `data:text/html,
      <html>
        <head><title>Page D</title></head>
        <body>
          <button>Submit Button</button>
          <button>Submit Button</button>
        </body>
      </html>
    `.replace(/\n/g, "");

    await browserService.navigate(profileName, tab.targetId, htmlD);
    await browserService.snapshot(profileName, tab.targetId);

    // Clicking e1 from snapshotA should now throw STALE_ELEMENT_REF with retryable=true
    await assert.rejects(
      async () => {
        await browserService.act(profileName, tab.targetId, {
          kind: "click",
          ref: "e1",
          snapshotId: snapshotA.snapshotId
        });
      },
      (err) => {
        assert.equal(err.code, "STALE_ELEMENT_REF");
        assert.equal(err.retryable, true);
        return true;
      }
    );

  } finally {
    if (tab) {
      try {
        await browserService.close(profileName, tab.targetId);
      } catch (err) {
        console.error("Failed to close tab:", err);
      }
    }
    await browserService.stop(profileName);
  }
});
