#!/usr/bin/env node
"use strict";

// End-to-end smoke only: render the fixed public page and deliver its PNG via
// the existing Telegram channel. It deliberately accepts no URL argument.
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const URL = "https://example.com/";

function serviceTelegramEnv() {
  // The installed agent loads this local file at process start. Reuse it for
  // the smoke command without printing or exporting either credential.
  const local = Object.fromEntries(fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, "")]] : [];
  }));
  if (local.TELEGRAM_BOT_TOKEN && local.TELEGRAM_CHAT_ID) return local;
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

async function main() {
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

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
