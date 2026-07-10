import fs from "node:fs";
import path from "node:path";

import { aiInteractionDir, aiInteractionIndex } from "../config/paths";

type AiInteractionRecord = {
  traceId: string;
  provider: string;
  model: string;
  direction: "request" | "response" | "error";
  payload: unknown;
};

function serialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, candidate) => {
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
