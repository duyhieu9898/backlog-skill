const assert = require("node:assert/strict");
const test = require("node:test");
const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());
process.env.ALLOW_DATA_URLS = "true";

const { browserService } = require("../dist/browser/browser-service");
const { AgentToolLoop } = require("../dist/tools/loop");
const { ToolExecutor } = require("../dist/tools/executor");
const { ToolGateway } = require("../dist/tools/gateway");
const { AiRouter } = require("../dist/brain/router");

test("AgentToolLoop returns stale snapshot recovery to the model without rebinding", async () => {
  const profileName = "test-retry-agent";
  await browserService.start(profileName);

  let tab = null;
  try {
    // 1. Open Page A with a unique button
    const htmlA = `data:text/html,
      <html>
        <body>
          <button>Click Me</button>
        </body>
      </html>
    `.replace(/\n/g, "");

    tab = await browserService.open(profileName, htmlA);
    const snapshotA = await browserService.snapshot(profileName, tab.targetId);
    assert.match(snapshotA.text, /button "Click Me" \[ref=e1\]/);

    // 2. Navigate to Page B (which has two buttons with same name, making e1 stale and ambiguous when resolved)
    const htmlB = `data:text/html,
      <html>
        <body>
          <button>Click Me</button>
          <button>Click Me</button>
        </body>
      </html>
    `.replace(/\n/g, "");
    await browserService.navigate(profileName, tab.targetId, htmlB);
    
    // We snapshot Page B to update the latest snapshot, making snapshotA stale
    const snapshotB = await browserService.snapshot(profileName, tab.targetId);
    assert.notEqual(snapshotB.snapshotId, snapshotA.snapshotId);

    // 3. Set up the ToolExecutor and AgentToolLoop
    // We will stub a provider that will call browser.act using the stale ref e1 from snapshotA
    const provider = {
      async complete(input) {
        if (input.steps.length === 0) {
          return {
            toolCall: {
              name: "browser",
              arguments: {
                action: "act",
                profile: profileName,
                targetId: tab.targetId,
                request: {
                  kind: "click",
                  ref: "e1",
                  snapshotId: snapshotA.snapshotId
                }
              }
            }
          };
        }
        
        assert.equal(input.steps.length, 1);
        assert.equal(input.steps[0].result.code, "SNAPSHOT_STALE_REVISION");
        assert.equal(input.steps[0].result.data?.recovery?.requiresNewSnapshot, true);

        return { text: "success" };
      }
    };

    const loop = new AgentToolLoop(
      new AiRouter({ provider, providerName: "fake", model: "fake", systemPrompt: "test" }),
      new ToolGateway(new ToolExecutor())
    );

    // 4. Run the loop
    const initialMessage = {
      traceId: "test-retry-trace",
      provider: "telegram",
      chatId: "test-retry-chat",
      userId: "user",
      text: "click the stale button",
      timestamp: new Date()
    };

    let capturedArtifactId = null;
    const response = await loop.run(initialMessage, { history: [], runtime: { currentTime: "2026-07-13T10:00:00", timezone: "Asia/Ho_Chi_Minh", locale: "vi-VN" } }, undefined, (artifactId) => {
      capturedArtifactId = artifactId;
    });

    // 5. Verify the results
    assert.equal(response, "success");
    assert.equal(capturedArtifactId, null);
    
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
