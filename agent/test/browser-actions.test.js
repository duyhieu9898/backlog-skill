const assert = require("node:assert/strict");
const test = require("node:test");
process.env.ALLOW_DATA_URLS = "true";

const { browserService } = require("../dist/browser/browser-service");

test("BrowserService binds ref actions to the latest snapshot", async () => {
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

    // A ref is a snapshot-bound capability, not a selector that can be
    // rebound to a matching element on a later document.
    await assert.rejects(
      async () => {
        await browserService.act(profileName, tab.targetId, {
          kind: "click",
          ref: "e1",
          snapshotId: snapshotA.snapshotId
        });
      },
      (err) => {
        assert.equal(err.code, "SNAPSHOT_STALE_REVISION");
        return true;
      }
    );
    const clickedTab = await browserService.act(profileName, tab.targetId, {
      kind: "click", ref: "e1", snapshotId: snapshotB.snapshotId
    });
    assert.equal(clickedTab.targetId, tab.targetId);

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

test("BrowserService rejects a ref after navigation even without a newer snapshot (silent-rebind fix)", async () => {
  const profileName = "test-actions-rebind";

  await browserService.start(profileName);
  let tab = null;
  try {
    const htmlA = `data:text/html,<html><head><title>A</title></head><body><button>Submit Button</button></body></html>`;
    tab = await browserService.open(profileName, htmlA);
    const snapshotA = await browserService.snapshot(profileName, tab.targetId);

    // Navigate to Page B with an identically-named button, but do NOT re-snapshot.
    const htmlB = `data:text/html,<html><head><title>B</title></head><body><button>Submit Button</button></body></html>`;
    await browserService.navigate(profileName, tab.targetId, htmlB);

    // Pre-fix: snapshotA would still be "latest" and its ref would silently
    // rebind to Page B's identically-named button. Post-fix: the document-
    // generation gate rejects the stale snapshot even though no newer one exists.
    await assert.rejects(
      async () => browserService.act(profileName, tab.targetId, { kind: "click", ref: "e1", snapshotId: snapshotA.snapshotId }),
      (err) => { assert.equal(err.code, "SNAPSHOT_STALE_REVISION"); return true; },
    );

    // A fresh snapshot on Page B re-enables the ref.
    const snapshotB = await browserService.snapshot(profileName, tab.targetId);
    const clicked = await browserService.act(profileName, tab.targetId, { kind: "click", ref: "e1", snapshotId: snapshotB.snapshotId });
    assert.equal(clicked.targetId, tab.targetId);
  } finally {
    if (tab) {
      try { await browserService.close(profileName, tab.targetId); } catch (err) { console.error("Failed to close tab:", err); }
    }
    await browserService.stop(profileName);
  }
});
