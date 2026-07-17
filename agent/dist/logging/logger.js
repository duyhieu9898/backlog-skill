"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.log = void 0;
exports.redactString = redactString;
exports.sanitizeForLog = sanitizeForLog;
const repositories_1 = require("../storage/repositories");
function redactString(value) {
    return value
        .replace(/\b((?:bearer|basic))\s+[a-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
        .replace(/\b(?:sk|rk|pk)_[a-z0-9_-]{12,}\b/gi, "[redacted]")
        .replace(/\b(?:ghp|github_pat)_[a-z0-9_]{12,}\b/gi, "[redacted]")
        .replace(/(authorization\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
        .replace(/(password|passwd|token|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
function sanitizeForLog(value) {
    if (typeof value === "string")
        return redactString(value);
    if (!value || typeof value !== "object")
        return value;
    if (Array.isArray(value))
        return value.map(sanitizeForLog);
    const clean = {};
    for (const [key, raw] of Object.entries(value)) {
        if (key === "usage" || key === "usageMetadata" || key === "tokenAttribution" || key === "tokensBefore") {
            // Token counts are usage metrics, not secrets; keep them so eval/audit
            // can account for cost even though child keys contain "token".
            clean[key] = raw;
        }
        else if (/token|secret|password|api[_-]?key|cookie/i.test(key)) {
            clean[key] = "[redacted]";
        }
        else if (raw instanceof Error) {
            clean[key] = { name: raw.name, message: raw.message, stack: raw.stack };
        }
        else {
            clean[key] = sanitizeForLog(raw);
        }
    }
    return clean;
}
function write(level, traceId, event, payload = {}) {
    const entry = {
        level,
        traceId,
        event,
        payload: sanitizeForLog(payload),
        at: new Date().toISOString(),
    };
    const line = JSON.stringify(entry);
    // Router replies are the CLI's only stdout contract; operational logs belong
    // on stderr for both local CLI and the background service.
    console.error(line);
    (0, repositories_1.insertTraceEvent)(traceId, event, entry.payload);
}
exports.log = {
    info: (traceId, event, payload) => write("info", traceId, event, payload),
    warn: (traceId, event, payload) => write("warn", traceId, event, payload),
    error: (traceId, event, payload) => write("error", traceId, event, payload),
};
