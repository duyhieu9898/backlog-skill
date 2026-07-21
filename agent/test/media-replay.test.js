// US-027 mảng 4 — media replay / asset marker (ADR-0020, research §178-204).
//
// Media from tool artifacts is persisted once as a lightweight asset reference
// (hash + dimensions), never repeated as base64 every turn. Old processed media
// is represented in replay by an informative text marker; rehydration restores
// metadata only and NEVER revives a snapshot-bound browser ref. Budgets are
// config-driven, measurable values — not hard-coded constants.
//
// Deterministic only. Real-provider proof (Gemini image modality, browser ref
// non-revival against a live RefStore) is deferred to the real-trace round.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const closeIsolatedDb = require("./helpers/db");
test.after(() => closeIsolatedDb());

const {
  renderObservationMarker,
  observationMarkerFromRef,
  rehydrateAssetRef,
  extractArtifactId,
  pngDimensions,
  selectAssetsForReplay,
  defaultReplayLimits,
  REF_REVIVAL_KEYS,
} = require("../dist/context/media-asset");
const { ArtifactStore } = require("../dist/artifacts/store");
const { ContextHydrator } = require("../dist/context/hydrator");
const { SkillRegistry } = require("../dist/skills/registry");
const {
  appendRunStep,
  createRun,
  insertChatMessage,
} = require("../dist/storage/repositories");

// --- helpers --------------------------------------------------------------

function tmpArtifactRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-replay-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Minimal valid PNG header (signature + IHDR) carrying the given dimensions.
 *  CRC bytes are left zero — pngDimensions validates the signature, not CRC. */
function pngHeader(width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "ascii");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  ihdr[18] = 0;
  ihdr[19] = 0;
  ihdr[20] = 0;
  return Buffer.concat([sig, ihdr]);
}

// --- pure media-asset unit tests ------------------------------------------

test("pngDimensions reads width and height from a PNG IHDR", () => {
  assert.deepEqual(pngDimensions(pngHeader(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(pngDimensions(pngHeader(1440, 1080)), { width: 1440, height: 1080 });
});

test("pngDimensions rejects a non-PNG buffer", () => {
  assert.equal(pngDimensions(Buffer.from([0, 0, 0])), undefined);
  assert.equal(pngDimensions(Buffer.from("not a png")), undefined);
});

test("extractArtifactId finds an artifact id embedded in a tool result", () => {
  assert.equal(extractArtifactId({ ok: true, data: { artifactId: "art-1" } }), "art-1");
  assert.equal(extractArtifactId({ ok: true, data: { artifactId: 42 } }), undefined);
  assert.equal(extractArtifactId({ ok: true, data: {} }), undefined);
  assert.equal(extractArtifactId(undefined), undefined);
});

test("a rehydrated asset reference carries metadata only — never browser-ref authority", () => {
  const ref = rehydrateAssetRef({
    assetId: "art-1",
    mimeType: "image/png",
    sha256: "abc",
    byteSize: 1024,
    width: 800,
    height: 600,
    observationSummary: "login form",
  });
  // Metadata survives rehydration …
  assert.equal(ref.assetId, "art-1");
  assert.equal(ref.width, 800);
  assert.equal(ref.observationSummary, "login form");
  // … but no snapshot-bound browser-ref authority is restored (ADR-0020).
  for (const key of REF_REVIVAL_KEYS) {
    assert.equal(ref[key], undefined, `rehydrated ref must not carry ${key}`);
    assert.ok(!Object.keys(ref).includes(key), `rehydrated ref must not serialize ${key}`);
  }
});

test("rehydrateAssetRef whitelists fields and drops injected ref identity", () => {
  // A caller must not be able to graft browser-ref identity onto a rehydrated
  // asset by feeding it extra keys.
  const ref = rehydrateAssetRef({
    assetId: "art-2",
    mimeType: "image/png",
    sha256: "def",
    byteSize: 8,
    ref: "btn-login",
    snapshotId: "snap-old",
    targetId: "tab-1",
  });
  assert.equal(ref.ref, undefined);
  assert.equal(ref.snapshotId, undefined);
  assert.equal(ref.targetId, undefined);
});

test("a full observation marker is informative and carries no ref identity", () => {
  const marker = observationMarkerFromRef({
    assetId: "art-3",
    mimeType: "image/png",
    sha256: "x",
    byteSize: 4,
    width: 1024,
    height: 768,
    observationSummary: "order confirmation page",
  }, "full");
  const text = renderObservationMarker(marker);
  assert.match(text, /art-3/);
  assert.match(text, /image\/png/);
  assert.match(text, /1024x768/);
  assert.match(text, /order confirmation page/);
  // The marker is text; it never leaks ref/snapshot/target identity.
  for (const key of ["ref=", "snapshotId", "targetId", "sessionId"]) {
    assert.doesNotMatch(text, new RegExp(key), `marker text must not mention ${key}`);
  }
});

test("a minimal marker omits dimensions and observation to bound replay cost", () => {
  const marker = observationMarkerFromRef({
    assetId: "art-4",
    mimeType: "image/png",
    sha256: "y",
    byteSize: 4,
    width: 1024,
    height: 768,
    observationSummary: "dense grid",
  }, "minimal");
  const text = renderObservationMarker(marker);
  assert.match(text, /art-4/);
  assert.doesNotMatch(text, /1024x768/);
  assert.doesNotMatch(text, /dense grid/);
});

test("selectAssetsForReplay keeps the N most recent rich, rest minimal, from config", () => {
  const refs = ["a", "b", "c", "d"].map((assetId) => ({
    assetId, mimeType: "image/png", sha256: assetId, byteSize: 1,
  }));
  // Default budget: at most 2 hydrated screenshots → last two are "full".
  assert.deepEqual(selectAssetsForReplay(refs, defaultReplayLimits()),
    ["minimal", "minimal", "full", "full"]);
  // Config override is honored and measurable.
  assert.deepEqual(
    selectAssetsForReplay(refs, defaultReplayLimits({ maxHydratedScreenshots: 3 })),
    ["minimal", "full", "full", "full"],
  );
  assert.deepEqual(
    selectAssetsForReplay(refs, defaultReplayLimits({ maxHydratedScreenshots: 0 })),
    ["minimal", "minimal", "minimal", "minimal"],
  );
});

// --- store: persistence, dedup, dimensions, audit -------------------------

test("artifact store persists media once with dimensions and an observation summary", (t) => {
  const root = tmpArtifactRoot(t);
  const store = new ArtifactStore(root);
  const artifact = store.create({
    ownerChatId: "chat-a",
    sourceTraceId: "trace-a",
    mimeType: "image/png",
    bytes: pngHeader(640, 480),
    observationSummary: "settings dialog",
  });
  assert.equal(artifact.width, 640);
  assert.equal(artifact.height, 480);
  assert.equal(artifact.observation_summary, "settings dialog");

  const meta = store.getMetadata(artifact.id);
  assert.equal(meta.assetId, artifact.id);
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 480);
  assert.equal(meta.observationSummary, "settings dialog");
  assert.equal(meta.sha256.length, 64);
});

test("artifact store deduplicates identical media by content hash instead of re-storing", (t) => {
  const root = tmpArtifactRoot(t);
  const store = new ArtifactStore(root);
  const bytes = pngHeader(320, 240);
  const first = store.create({ ownerChatId: "chat-a", sourceTraceId: "t1", mimeType: "image/png", bytes });
  const second = store.create({ ownerChatId: "chat-a", sourceTraceId: "t2", mimeType: "image/png", bytes });
  assert.equal(second.id, first.id, "same content hash → same asset, no duplicate bytes");
  assert.equal(second.sha256, first.sha256);
});

test("metadata stays queryable for audit after the bytes are soft-deleted on delivery", (t) => {
  const root = tmpArtifactRoot(t);
  const store = new ArtifactStore(root);
  const artifact = store.create({
    ownerChatId: "chat-a",
    sourceTraceId: "trace-a",
    mimeType: "image/png",
    bytes: pngHeader(1280, 720),
    observationSummary: "checkout page",
  });
  assert.equal(fs.existsSync(artifact.local_path), true);
  store.markDelivered(artifact.id);
  // Bytes are gone …
  assert.equal(fs.existsSync(artifact.local_path), false);
  assert.throws(() => store.claim(artifact.id, "chat-a"), /unavailable/);
  // … but the metadata row remains queryable for audit/replay-by-asset-id.
  const meta = store.getMetadata(artifact.id);
  assert.ok(meta, "metadata row survives byte deletion");
  assert.equal(meta.width, 1280);
  assert.equal(meta.height, 720);
  assert.equal(meta.observationSummary, "checkout page");
});

test("getMetadata rehydrates an asset by id without restoring browser refs", (t) => {
  const root = tmpArtifactRoot(t);
  const store = new ArtifactStore(root);
  const artifact = store.create({
    ownerChatId: "chat-a",
    sourceTraceId: "trace-a",
    mimeType: "image/png",
    bytes: pngHeader(100, 100),
  });
  const ref = rehydrateAssetRef(store.getMetadata(artifact.id));
  for (const key of REF_REVIVAL_KEYS) {
    assert.equal(ref[key], undefined);
  }
});

// --- hydrator integration: old media → marker in the replay view ----------

function setupScreenshotStep(chatId, runId, artifactId, summary, contentText) {
  insertChatMessage({ chatId, userId: "user", role: "user", content: contentText, traceId: runId });
  createRun({
    id: runId, session_id: "default", principal_id: "user",
    channel: "telegram", user_request: contentText, trace_id: runId,
  });
  appendRunStep({
    runId,
    toolName: "computer",
    call: { name: "computer", arguments: { action: "screenshot" } },
    result: { ok: true, code: "COMPUTER_SCREENSHOT", summary, data: { artifactId } },
  });
}

test("an old tool screenshot is replayed as a text marker, not re-embedded media", (t) => {
  const artifactRoot = tmpArtifactRoot(t);
  const store = new ArtifactStore(artifactRoot);
  const chatId = `media-replay-${Date.now()}`;
  const oldRun = `media-replay-old-${Date.now()}`;

  // Persist the screenshot once (with dimensions + observation) …
  const artifact = store.create({
    ownerChatId: chatId,
    sourceTraceId: oldRun,
    mimeType: "image/png",
    bytes: pngHeader(800, 600),
    observationSummary: "the old login screen",
  });
  // … deliver it so the bytes are gone (simulating a past turn) …
  store.markDelivered(artifact.id);
  // … and leave a durable tool step that references it only by asset id.
  setupScreenshotStep(chatId, oldRun, artifact.id, "Screen captured.", "look at the screen");

  const prompt = new ContextHydrator(new SkillRegistry(path.join(__dirname, "..", "..", "skills"))).hydrate({
    traceId: `media-replay-now-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "user",
    text: "what was on the screen earlier?",
    timestamp: new Date(),
  }).prompt;

  const block = prompt.history.find((entry) => entry.content.includes("[TOOL CALL]"));
  assert.ok(block, "the durable tool step is replayed as one atomic block");
  // The block carries an informative observation marker for the old media …
  assert.match(block.content, /\[PROCESSED MEDIA ASSET\]/);
  assert.match(block.content, /the old login screen/);
  assert.match(block.content, /800x600/);
  // … and it never repeats the base64 pixels or revives browser-ref identity.
  assert.doesNotMatch(block.content, /ref=|snapshotId|targetId/);
});

test("only the configured budget of recent screenshots receives a full marker", (t) => {
  const artifactRoot = tmpArtifactRoot(t);
  const store = new ArtifactStore(artifactRoot);
  const chatId = `media-replay-budget-${Date.now()}`;
  const summaries = ["oldest shot", "older shot", "recent shot", "latest shot"];
  summaries.forEach((summary, index) => {
    const runId = `media-budget-run-${Date.now()}-${index}`;
    const artifact = store.create({
      ownerChatId: chatId,
      sourceTraceId: runId,
      mimeType: "image/png",
      bytes: pngHeader(100 + index, 100 + index),
      observationSummary: summary,
    });
    store.markDelivered(artifact.id);
    setupScreenshotStep(chatId, runId, artifact.id, "Screen captured.", `shot ${index}`);
  });

  const prompt = new ContextHydrator(new SkillRegistry(path.join(__dirname, "..", "..", "skills"))).hydrate({
    traceId: `media-budget-now-${Date.now()}`,
    provider: "telegram",
    chatId,
    userId: "user",
    text: "walk me through the screens",
    timestamp: new Date(),
  }).prompt;

  const blocks = prompt.history.filter((entry) => entry.content.includes("[PROCESSED MEDIA ASSET]"));
  // Default budget of 2 → exactly the two most recent screenshots keep their
  // observation; the older two are reduced to a minimal marker (no observation).
  assert.equal(blocks.length, 4, "all four durable screenshots replay as markers");
  const withObservation = blocks.filter((entry) =>
    /latest shot|recent shot|older shot|oldest shot/.test(entry.content));
  assert.equal(withObservation.length, 2, "only the configured budget keeps its observation");
  assert.ok(
    withObservation.every((entry) => /latest shot|recent shot/.test(entry.content)),
    "the retained observations are the most recent screenshots",
  );
});
