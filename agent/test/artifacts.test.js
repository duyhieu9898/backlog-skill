const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ArtifactStore } = require("../dist/artifacts/store");
const { deliverResponse, presentArtifact } = require("../dist/core/presenter");

test("artifact store keeps bytes locally and enforces owner, expiry, and cleanup", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  const artifact = store.create({ ownerChatId: "chat-a", sourceTraceId: "trace-a", mimeType: "text/plain", bytes: Buffer.from("hello") });
  assert.equal(fs.existsSync(artifact.local_path), true);
  assert.equal(store.claim(artifact.id, "chat-a").sha256.length, 64);
  assert.throws(() => store.claim(artifact.id, "chat-b"), /unavailable/);
  store.markDelivered(artifact.id);
  assert.throws(() => store.claim(artifact.id, "chat-a"), /unavailable/);
  const expired = store.create({ ownerChatId: "chat-a", sourceTraceId: "trace-b", mimeType: "text/plain", bytes: Buffer.from("expired"), ttlMs: -1 });
  assert.ok(store.cleanupExpired() >= 1);
  assert.equal(fs.existsSync(expired.local_path), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("artifact store rejects unsupported and oversized input", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  assert.throws(() => store.create({ ownerChatId: "chat", sourceTraceId: "trace", mimeType: "application/octet-stream", bytes: Buffer.from("x") }), /Unsupported/);
  assert.throws(() => store.create({ ownerChatId: "chat", sourceTraceId: "trace", mimeType: "text/plain", bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }), /size/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("presenter delivers an owned artifact once and marks it consumed only after upload", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  const artifact = store.create({ ownerChatId: "chat-a", sourceTraceId: "trace", mimeType: "text/plain", bytes: Buffer.from("safe") });
  const sent = [];
  const channel = {
    async sendMessage(chatId, text) { sent.push(["text", chatId, text]); },
    async sendArtifact(chatId, row) { sent.push(["artifact", chatId, row.id]); },
  };
  await deliverResponse(channel, "chat-a", presentArtifact("Artifact ready", artifact), undefined, store);
  assert.deepEqual(sent.map((entry) => entry[0]), ["text", "artifact"]);
  assert.equal(fs.existsSync(artifact.local_path), false);
  assert.throws(() => store.claim(artifact.id, "chat-a"), /unavailable/);
  fs.rmSync(root, { recursive: true, force: true });
});
