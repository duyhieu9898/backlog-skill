#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const agentDir = path.resolve(__dirname, "..");
loadEnv(path.join(agentDir, ".env"));

const config = JSON.parse(fs.readFileSync(path.join(agentDir, "config.json"), "utf8"));
const gemini = config.ai.providers.gemini;
const apiKey = process.env[gemini.apiKeyEnv];

if (!apiKey) {
  console.error(`Missing ${gemini.apiKeyEnv} in environment or .env`);
  process.exit(1);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)\s*$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

async function main() {
  const modelPath = gemini.model.startsWith("models/") ? gemini.model : `models/${gemini.model}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: "Reply with exactly: agent-gemini-ok" }],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 256,
      },
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    console.error(`Gemini test failed: HTTP ${response.status}`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("").trim();
  if (!text) {
    console.error("Gemini test failed: response did not contain text");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log(`Gemini model: ${gemini.model}`);
  console.log(`Gemini response: ${text}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
