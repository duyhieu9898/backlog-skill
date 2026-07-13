import { insertTraceEvent } from "../storage/repositories";

type LogLevel = "info" | "warn" | "error";

function sanitize(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitize);

  const clean: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (/token|secret|password|api[_-]?key|cookie/i.test(key)) {
      clean[key] = "[redacted]";
    } else if (raw instanceof Error) {
      clean[key] = { name: raw.name, message: raw.message, stack: raw.stack };
    } else {
      clean[key] = sanitize(raw);
    }
  }
  return clean;
}

function write(level: LogLevel, traceId: string, event: string, payload: unknown = {}): void {
  const entry = {
    level,
    traceId,
    event,
    payload: sanitize(payload),
    at: new Date().toISOString(),
  };
  const line = JSON.stringify(entry);
  // Router replies are the CLI's only stdout contract; operational logs belong
  // on stderr for both local CLI and the background service.
  console.error(line);
  insertTraceEvent(traceId, event, entry.payload);
}

export const log = {
  info: (traceId: string, event: string, payload?: unknown) => write("info", traceId, event, payload),
  warn: (traceId: string, event: string, payload?: unknown) => write("warn", traceId, event, payload),
  error: (traceId: string, event: string, payload?: unknown) => write("error", traceId, event, payload),
};
