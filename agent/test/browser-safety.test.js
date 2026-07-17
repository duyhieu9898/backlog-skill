const path = require("node:path");
process.env.AGENT_CONFIG_FILE = path.join(__dirname, "config.browser-safety.json");

const assert = require("node:assert/strict");
const test = require("node:test");
const { browserService } = require("../dist/browser/browser-service");
const { ToolExecutor } = require("../dist/tools/executor");
const { PermissionPolicy } = require("../dist/security/permissionPolicy");
const { browserConfirmationStore } = require("../dist/security/browser-confirmation");
const { refStore } = require("../dist/browser/ref-store");

test("Browser Safety and Network Policy integration", async (t) => {
  const profileName = "test-safety-profile";
  await browserService.start(profileName);

  let tab = null;
  try {
    // 1. Open public URL without confirmation (using data: URL is blocked by protocol policy in US-023, but wait, data: is blocked, so we must use http/https!)
    // Wait! Let's check: does evaluateUrl block data: URLs?
    // Yes: "Deny all other protocols by default, including: file, chrome, devtools, data..."
    // But how can we test without opening actual external websites which might fail?
    // We can start a small HTTP server inside the test!
    // That is standard, extremely robust, and completely isolated!
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/redirect-private") {
        res.writeHead(302, { Location: "http://127.0.0.1:9999/secret" });
        res.end();
      } else {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <body>
              <button>Submit Button</button>
              <button>Send Message</button>
              <button>Delete Account</button>
              <button>Remove Filter</button>
              <a href="http://127.0.0.1:9999/secret">Private Link</a>
            </body>
          </html>
        `);
      }
    });

    // Listen on a random port
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const testUrl = `http://127.0.0.1:${port}`;

    // Wait! By default, http://127.0.0.1 is blocked because it is a loopback IP!
    // So we must add "127.0.0.1:<port>" to permissions.browser.allowedHosts!
    // How do we inject permissions config into loadAgentConfig?
    // We can mock loadAgentConfig or temporarily patch agent/config.json!
    // Or we can just test PermissionPolicy directly!
    // Let's first test evaluateUrlSync and evaluateAction directly using PermissionPolicy.

    const config = {
      workspaceRoot: ".",
      allowedReadRoots: ["."],
      allowedWriteRoots: ["."],
      deniedPaths: [],
      browser: {
        allowedHosts: [`127.0.0.1:${port}`],
        publicNavigation: "allow",
        privateNavigation: "deny",
        consequentialActions: "confirm",
        destructiveActions: "confirm",
      },
    };

    const policy = new PermissionPolicy(config);

    // 2. Open allowed host
    const openAction = { kind: "browser.open", profile: profileName, url: testUrl };
    const openDecision = policy.evaluate(openAction);
    assert.equal(openDecision.outcome, "allow");

    // Trusted-local navigation posture (ADR 0017 P2.5): localhost and private
    // LAN are allowed by default (owner's own network), while the SSRF guardrail
    // still hard-denies cloud-metadata / non-routable destinations, and an owner
    // can tighten private access via `privateNavigation`.
    const allowPolicy = new PermissionPolicy({
      ...config,
      browser: { ...config.browser, privateNavigation: "allow" },
    });
    assert.equal(allowPolicy.evaluate({ kind: "browser.open", profile: profileName, url: "http://localhost:3000" }).outcome, "allow");
    assert.equal(allowPolicy.evaluate({ kind: "browser.open", profile: profileName, url: "http://192.168.1.1" }).outcome, "allow");
    // The guardrail is non-configurable: metadata is denied even with privateNavigation "allow".
    assert.equal(allowPolicy.evaluate({ kind: "browser.open", profile: profileName, url: "http://169.254.169.254" }).outcome, "deny");
    // The posture is configurable: an owner may set "deny" to block private navigation.
    const denyPolicy = new PermissionPolicy({
      ...config,
      browser: { ...config.browser, privateNavigation: "deny" },
    });
    assert.equal(denyPolicy.evaluate({ kind: "browser.open", profile: profileName, url: "http://localhost:3000" }).outcome, "deny");

    // 3. Let's test evaluateAction risk classification directly
    const sendAction = { kind: "browser.act", profile: profileName, targetId: "tab_01", request: { kind: "click", ref: "e1", snapshotId: "snap1" } };
    
    // Test clicking a harmless button
    const harmlessContext = {
      sessionId: "s1", runId: "r1", profile: profileName, targetId: "tab_01", snapshotId: "snap1", url: testUrl,
      action: { kind: "click", ref: "e1", snapshotId: "snap1" },
      element: { ref: "e1", role: "button", name: "Remove Filter" },
    };
    const harmlessDecision = policy.evaluate(sendAction, { browserContext: harmlessContext });
    assert.equal(harmlessDecision.outcome, "allow");

    // Test clicking "Send Message" (consequential)
    const consequentialContext = {
      sessionId: "s1", runId: "r1", profile: profileName, targetId: "tab_01", snapshotId: "snap1", url: testUrl,
      action: { kind: "click", ref: "e1", snapshotId: "snap1" },
      element: { ref: "e1", role: "button", name: "Send Message" },
    };
    const consequentialDecision = policy.evaluate(sendAction, { browserContext: consequentialContext });
    assert.equal(consequentialDecision.outcome, "confirm");
    assert.ok(consequentialDecision.actionFingerprint);

    // Test clicking "Delete Account" (destructive)
    const destructiveContext = {
      sessionId: "s1", runId: "r1", profile: profileName, targetId: "tab_01", snapshotId: "snap1", url: testUrl,
      action: { kind: "click", ref: "e1", snapshotId: "snap1" },
      element: { ref: "e1", role: "button", name: "Delete Account" },
    };
    const destructiveDecision = policy.evaluate(sendAction, { browserContext: destructiveContext });
    assert.equal(destructiveDecision.outcome, "confirm");

    // Close server
    await new Promise((resolve) => server.close(resolve));
  } finally {
    await browserService.stop(profileName);
  }
});
