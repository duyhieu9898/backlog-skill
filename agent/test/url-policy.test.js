const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateUrl, isPrivateIp, isPrivateHostname, isSsrfGuardedIp } = require("../dist/browser/url-policy");

test("isPrivateIp helper", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.100"), true);
  assert.equal(isPrivateIp("172.16.5.5"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("172.32.0.1"), false); // outside Class B private range
  assert.equal(isPrivateIp("169.254.169.254"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fe80::1234"), true);
  assert.equal(isPrivateIp("2001:db8::1"), false); // documentation range, not private/loopback/link-local
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("::ffff:192.168.0.1"), true);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("isPrivateHostname helper", () => {
  assert.equal(isPrivateHostname("localhost"), true);
  assert.equal(isPrivateHostname("localhost.localdomain"), true);
  assert.equal(isPrivateHostname("my-router"), true); // no dot
  assert.equal(isPrivateHostname("service.local"), true);
  assert.equal(isPrivateHostname("server.lan"), true);
  assert.equal(isPrivateHostname("dev.internal"), true);
  assert.equal(isPrivateHostname("google.com"), false);
});

test("evaluateUrl - navigation protocols", async () => {
  assert.equal((await evaluateUrl({ url: "https://google.com", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://example.org/path", allowedHosts: [] })).decision, "allow");

  const fileRes = await evaluateUrl({ url: "file:///etc/passwd", allowedHosts: [] });
  assert.equal(fileRes.decision, "deny");
  assert.equal(fileRes.code, "NAVIGATION_PROTOCOL_BLOCKED");

  const jsRes = await evaluateUrl({ url: "javascript:alert(1)", allowedHosts: [] });
  assert.equal(jsRes.decision, "deny");
  assert.equal(jsRes.code, "NAVIGATION_PROTOCOL_BLOCKED");

  const dataRes = await evaluateUrl({ url: "data:text/html,<h1>Hello</h1>", allowedHosts: [] });
  assert.equal(dataRes.decision, "deny");
  assert.equal(dataRes.code, "NAVIGATION_PROTOCOL_BLOCKED");
});

test("isSsrfGuardedIp helper — the non-configurable guardrail set", () => {
  // Cloud metadata / link-local and non-routable ranges stay hard-denied.
  assert.equal(isSsrfGuardedIp("169.254.169.254"), true);
  assert.equal(isSsrfGuardedIp("169.254.0.1"), true);
  assert.equal(isSsrfGuardedIp("0.0.0.0"), true);
  assert.equal(isSsrfGuardedIp("224.0.0.1"), true); // multicast
  assert.equal(isSsrfGuardedIp("240.0.0.1"), true); // reserved
  // Private LAN and loopback are NOT guardrail-denied — they are owner network.
  assert.equal(isSsrfGuardedIp("127.0.0.1"), false);
  assert.equal(isSsrfGuardedIp("10.0.0.1"), false);
  assert.equal(isSsrfGuardedIp("192.168.1.1"), false);
  assert.equal(isSsrfGuardedIp("172.16.5.5"), false);
  assert.equal(isSsrfGuardedIp("8.8.8.8"), false);
});

test("evaluateUrl - SSRF guardrail blocks metadata and non-routable destinations", async () => {
  const metadata = await evaluateUrl({ url: "http://169.254.169.254", allowedHosts: [] });
  assert.equal(metadata.decision, "deny");
  assert.equal(metadata.code, "NAVIGATION_PRIVATE_NETWORK_BLOCKED");

  assert.equal((await evaluateUrl({ url: "http://169.254.0.1", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://0.0.0.0", allowedHosts: [] })).decision, "deny");
});

test("evaluateUrl - private LAN, loopback, and localhost are allowed by default (trusted-local)", async () => {
  // Under ADR 0017 the owner's local network is legitimate; only the gateway
  // posture (privateNavigation) may tighten it. The url-policy guardrail itself
  // no longer blocks these.
  assert.equal((await evaluateUrl({ url: "http://127.0.0.1", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://localhost", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://localhost.", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://10.0.0.1:8080", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://192.168.1.1", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://[::1]", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://[fc00::1]", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://[fe80::1]", allowedHosts: [] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://dev-server.local", allowedHosts: [] })).decision, "allow");
});

test("evaluateUrl - allowedHosts match", async () => {
  // exact allowed hosts
  assert.equal((await evaluateUrl({ url: "http://localhost:3000", allowedHosts: ["localhost:3000"] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://127.0.0.1:5173/dashboard", allowedHosts: ["127.0.0.1:5173"] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://dev-server.local", allowedHosts: ["dev-server.local"] })).decision, "allow");

  // A private host with a non-listed port is still allowed: under the
  // trusted-local model private destinations default-allow regardless of port.
  const wrongPortRes = await evaluateUrl({ url: "http://localhost:3001", allowedHosts: ["localhost:3000"] });
  assert.equal(wrongPortRes.decision, "allow");

  // hostname suffix bypass
  const suffixRes = await evaluateUrl({ url: "http://localhost3000.com", allowedHosts: ["localhost:3000"] });
  assert.equal(suffixRes.decision, "allow"); // it is a public domain and allowed by default!
  
  const suffixBypassRes = await evaluateUrl({ url: "http://localhost.attacker.com", allowedHosts: ["localhost"] });
  assert.equal(suffixBypassRes.decision, "allow"); // it's a public domain, not matching localhost exactly.
});

test("evaluateUrl - malformed and validation", async () => {
  const malformed = await evaluateUrl({ url: "http://", allowedHosts: [] });
  assert.equal(malformed.decision, "deny");
  assert.equal(malformed.code, "NAVIGATION_INVALID_URL");
});

test("evaluateUrl - DNS resolution catches SSRF-guarded destinations", async () => {
  // metadata.google.internal is a cloud-metadata SSRF target. Outside its cloud
  // it does not resolve (denied as unresolvable); inside, it resolves to the
  // link-local 169.254.x metadata IP (denied by the SSRF guardrail). Either way
  // the guardrail denies it — it is never allowed through to navigation.
  const metaRes = await evaluateUrl({ url: "http://metadata.google.internal", allowedHosts: [] });
  assert.equal(metaRes.decision, "deny");
  assert.ok(
    metaRes.code === "NAVIGATION_PRIVATE_NETWORK_BLOCKED" || metaRes.code === "NAVIGATION_INVALID_URL",
    `unexpected code ${metaRes.code}`,
  );
});
