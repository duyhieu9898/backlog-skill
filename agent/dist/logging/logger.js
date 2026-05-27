"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
const repositories_1 = require("../storage/repositories");
function sanitize(value) {
    if (!value || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return value.map(sanitize);
    const clean = {};
    for (const [key, raw] of Object.entries(value)) {
        if (/token|secret|password|api[_-]?key|cookie/i.test(key)) {
            clean[key] = "[redacted]";
        }
        else if (raw instanceof Error) {
            clean[key] = { name: raw.name, message: raw.message, stack: raw.stack };
        }
        else {
            clean[key] = sanitize(raw);
        }
    }
    return clean;
}
function write(level, traceId, event, payload = {}) {
    const entry = {
        level,
        traceId,
        event,
        payload: sanitize(payload),
        at: new Date().toISOString(),
    };
    const line = JSON.stringify(entry);
    if (level === "error")
        console.error(line);
    else
        console.log(line);
    (0, repositories_1.insertTraceEvent)(traceId, event, entry.payload);
}
exports.log = {
    info: (traceId, event, payload) => write("info", traceId, event, payload),
    warn: (traceId, event, payload) => write("warn", traceId, event, payload),
    error: (traceId, event, payload) => write("error", traceId, event, payload),
};
