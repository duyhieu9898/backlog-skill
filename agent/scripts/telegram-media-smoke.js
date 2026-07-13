const path = require("node:path");

const { ArtifactStore } = require("../dist/artifacts/store");
const { agentDir } = require("../dist/config/paths");
const { loadEnv } = require("../dist/config/env");
const { logDesktopEvent } = require("../dist/desktop/events");
const { generateTraceId } = require("../dist/logging/trace");
const { TelegramClient } = require("../dist/telegram/client");
const { loadTelegramConfig } = require("../dist/telegram/config");

async function main() {
  loadEnv(path.join(agentDir, ".env"));
  const config = loadTelegramConfig();
  const traceId = generateTraceId();
  const store = new ArtifactStore();
  // A fixed transparent 1×1 PNG; it contains no host or user data.
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");
  const artifact = store.create({ ownerChatId: config.allowedChatId, sourceTraceId: traceId, mimeType: "image/png", bytes });
  try {
    await new TelegramClient(config).sendArtifact(config.allowedChatId, artifact, "US-014 media delivery smoke (1×1 transparent PNG)");
    store.markDelivered(artifact.id);
    logDesktopEvent(traceId, { component: "desktop", action: "artifact.delivery", outcome: "completed", artifactId: artifact.id });
    process.stdout.write(`Telegram media smoke passed. traceId: ${traceId}\n`);
  } catch (error) {
    logDesktopEvent(traceId, { component: "desktop", action: "artifact.delivery", outcome: "failed", artifactId: artifact.id, reasonCode: "TELEGRAM_UPLOAD_FAILED" });
    throw error;
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
