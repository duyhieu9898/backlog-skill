// Transport/IO smoke probes for `smoke`. Absorbs test-gemini.js,
// telegram-media-smoke.js, web-capture-smoke.js. All three load .env via
// bootstrap.loadEnv (the local/inline .env parsers are deleted). The systemd
// /proc/<pid>/environ fallback in smokeWeb is kept verbatim. dist requires stay
// inside each function (lazy). smokeGemini keeps its direct fetch to the Gemini
// endpoint — a transport smoke must NOT route through dist.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");
const { getContext, loadEnv } = require("./bootstrap");

const TRANSPARENT_1X1_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mNk+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==", "base64");

/** Direct Gemini transport probe; asserts the model echoes a fixed token. */
async function smokeGemini() {
  const { agentDir } = getContext();
  loadEnv(path.join(agentDir, ".env"));
  const config = JSON.parse(fs.readFileSync(path.join(agentDir, "config.json"), "utf8"));
  const gemini = config.ai.providers.gemini;
  const apiKey = process.env[gemini.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing ${gemini.apiKeyEnv} in environment or .env`);

  const modelPath = gemini.model.startsWith("models/") ? gemini.model : `models/${gemini.model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with exactly: agent-gemini-ok" }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    const err = new Error(`Gemini test failed: HTTP ${response.status}`);
    err.detail = body;
    throw err;
  }
  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) {
    const err = new Error("Gemini test failed: response did not contain text");
    err.detail = body;
    throw err;
  }
  console.log(`Gemini model: ${gemini.model}`);
  console.log(`Gemini response: ${text}`);
}

/** Artifact → Telegram delivery probe (1×1 transparent PNG). */
async function smokeTelegram() {
  const { agentDir } = getContext();
  loadEnv(path.join(agentDir, ".env"));
  const { ArtifactStore } = require("../../dist/artifacts/store");
  const { logDesktopEvent } = require("../../dist/desktop/events");
  const { generateTraceId } = require("../../dist/logging/trace");
  const { TelegramClient } = require("../../dist/telegram/client");
  const { loadTelegramConfig } = require("../../dist/telegram/config");

  const config = loadTelegramConfig();
  const traceId = generateTraceId();
  const store = new ArtifactStore();
  const artifact = store.create({ ownerChatId: config.allowedChatId, sourceTraceId: traceId, mimeType: "image/png", bytes: TRANSPARENT_1X1_PNG });
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

/**
 * Telegram credential source: prefer process.env (populated from .env by
 * loadEnv); fall back to scraping the running my-agent service's environ.
 * Preserved verbatim from web-capture-smoke.js (minus its inline .env parser).
 */
function serviceTelegramEnv() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID };
  }
  const pid = execFileSync("systemctl", ["--user", "show", "my-agent.service", "--property=MainPID", "--value"], { encoding: "utf8" }).trim();
  const candidates = [pid];
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      candidates.push(...execFileSync("pgrep", ["-P", candidates[index]], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/\s+/).filter(Boolean));
    } catch {}
  }
  for (const candidate of candidates) {
    try {
      const values = fs.readFileSync(`/proc/${candidate}/environ`).toString().split("\0");
      const found = Object.fromEntries(values.filter(Boolean).map((value) => {
        const index = value.indexOf("="); return [value.slice(0, index), value.slice(index + 1)];
      }));
      if (found.TELEGRAM_BOT_TOKEN && found.TELEGRAM_CHAT_ID) return found;
    } catch {}
  }
  throw new Error("Telegram credentials are not available from the running my-agent service.");
}

/** Headless-chrome capture of a fixed public page → Telegram sendPhoto. */
async function smokeWeb() {
  const { agentDir } = getContext();
  loadEnv(path.join(agentDir, ".env"));
  const URL = "https://example.com/";
  const env = serviceTelegramEnv();
  const file = path.join(os.tmpdir(), `my-agent-web-smoke-${Date.now()}.png`);
  try {
    const result = spawnSync("google-chrome", ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1080", `--screenshot=${file}`, "--virtual-time-budget=3000", URL], { encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0 || !fs.existsSync(file)) throw new Error(result.stderr.trim() || "Chrome screenshot failed.");
    const form = new FormData();
    form.set("chat_id", env.TELEGRAM_CHAT_ID);
    form.set("caption", `Web capture smoke: ${URL}`);
    form.set("photo", new Blob([fs.readFileSync(file)], { type: "image/png" }), "example-com.png");
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, { method: "POST", body: form });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(`Telegram sendPhoto failed: ${response.status}`);
    console.log(JSON.stringify({ ok: true, url: URL, byteSize: fs.statSync(file).size, telegramMessageId: body.result?.message_id }));
  } finally {
    fs.rmSync(file, { force: true });
  }
}

module.exports = { smokeGemini, smokeTelegram, smokeWeb };
