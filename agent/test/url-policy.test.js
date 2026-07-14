const assert = require("node:assert/strict");
const test = require("node:test");
const { evaluateUrl, isPrivateIp, isPrivateHostname } = require("../dist/browser/url-policy");

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

test("evaluateUrl - blocked loopback and private IPs", async () => {
  assert.equal((await evaluateUrl({ url: "http://127.0.0.1", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://localhost", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://localhost.", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://10.0.0.1:8080", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://192.168.1.1", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://169.254.169.254", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://[::1]", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://[fc00::1]", allowedHosts: [] })).decision, "deny");
  assert.equal((await evaluateUrl({ url: "http://[fe80::1]", allowedHosts: [] })).decision, "deny");
});

test("evaluateUrl - allowlist matches", async () => {
  // exact allowed hosts
  assert.equal((await evaluateUrl({ url: "http://localhost:3000", allowedHosts: ["localhost:3000"] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://127.0.0.1:5173/dashboard", allowedHosts: ["127.0.0.1:5173"] })).decision, "allow");
  assert.equal((await evaluateUrl({ url: "http://dev-server.local", allowedHosts: ["dev-server.local"] })).decision, "allow");

  // allowed host with wrong port
  const wrongPortRes = await evaluateUrl({ url: "http://localhost:3001", allowedHosts: ["localhost:3000"] });
  assert.equal(wrongPortRes.decision, "deny");

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

test("evaluateUrl - DNS resolution checks", async () => {
  // metadata.google.internal is private. It might not resolve, or if it does, it could resolve to private/link-local.
  // In either case, it ends with `.internal`, so it is classified as a private hostname and blocked immediately!
  const metaRes = await evaluateUrl({ url: "http://metadata.google.internal", allowedHosts: [] });
  assert.equal(metaRes.decision, "deny");
  assert.equal(metaRes.code, "NAVIGATION_HOST_NOT_ALLOWED");
});
