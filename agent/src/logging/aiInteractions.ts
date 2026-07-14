import fs from "node:fs";
import path from "node:path";

import { aiInteractionDir, aiInteractionIndex } from "../config/paths";
import { loadAgentConfig } from "../config/app";
import { sanitizeForLog } from "./logger";

type AiInteractionRecord = {
  traceId: string;
  provider: string;
  model: string;
  direction: "request" | "response" | "error";
  payload: unknown;
};

function serialize(value: unknown): string {
  const redact = (candidate: unknown): unknown => {
    if (typeof candidate === "string") return sanitizeForLog(candidate);
    if (Array.isArray(candidate)) return candidate.map(redact);
    if (!candidate || typeof candidate !== "object") return candidate;
    const object = candidate as Record<string, unknown>;
    if (object.inlineData && typeof object.inlineData === "object") {
      const inline = object.inlineData as Record<string, unknown>;
      return { ...object, inlineData: { ...inline, data: "[redacted inline image]" } };
    }
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => {
      if (/token|secret|password|api[_-]?key|cookie|authorization/i.test(key)) return [key, "[redacted]"];
      return [key, redact(entry)];
    }));
  };
  const seen = new WeakSet<object>();
  return JSON.stringify(redact(value), (_key, candidate) => {
    if (typeof candidate === "bigint") return candidate.toString();
    if (candidate instanceof Error) {
      return { name: candidate.name, message: candidate.message, stack: candidate.stack };
    }
    if (candidate && typeof candidate === "object") {
      if (seen.has(candidate)) return "[circular]";
      seen.add(candidate);
    }
    return candidate;
  });
}

export function appendRawAiInteraction(record: AiInteractionRecord): void {
  const logging = loadAgentConfig().logging;
  if (logging?.rawAiInteractions === false) return;
  pruneRawAiInteractions(logging?.rawAiRetentionDays ?? 14);
  const at = new Date().toISOString();
  const date = at.slice(0, 10);
  const safeTraceId = record.traceId.replace(/[^A-Za-z0-9_-]/g, "_");
  const relativeFile = path.join(date, `${safeTraceId}.jsonl`);
  const target = path.join(aiInteractionDir, relativeFile);
  const entry = { at, ...record };
  const serialized = serialize(entry);

  fs.mkdirSync(aiInteractionDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(aiInteractionDir, 0o700);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o700);
  fs.appendFileSync(
    target,
    `${serialized}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.appendFileSync(
    aiInteractionIndex,
    `${serialize({
      at,
      traceId: record.traceId,
      provider: record.provider,
      model: record.model,
      direction: record.direction,
      file: relativeFile,
      bytes: Buffer.byteLength(serialized, "utf8"),
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function pruneRawAiInteractions(retentionDays: number): void {
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || !fs.existsSync(aiInteractionDir)) return;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(aiInteractionDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const timestamp = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (!Number.isNaN(timestamp) && timestamp < cutoff) {
      fs.rmSync(path.join(aiInteractionDir, entry.name), { recursive: true, force: true });
    }
  }
}
