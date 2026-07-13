"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendRawAiInteraction = appendRawAiInteraction;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("../config/paths");
function serialize(value) {
    const redact = (candidate) => {
        if (Array.isArray(candidate))
            return candidate.map(redact);
        if (!candidate || typeof candidate !== "object")
            return candidate;
        const object = candidate;
        if (object.inlineData && typeof object.inlineData === "object") {
            const inline = object.inlineData;
            return { ...object, inlineData: { ...inline, data: "[redacted inline image]" } };
        }
        return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, redact(entry)]));
    };
    const seen = new WeakSet();
    return JSON.stringify(redact(value), (_key, candidate) => {
        if (typeof candidate === "bigint")
            return candidate.toString();
        if (candidate instanceof Error) {
            return { name: candidate.name, message: candidate.message, stack: candidate.stack };
        }
        if (candidate && typeof candidate === "object") {
            if (seen.has(candidate))
                return "[circular]";
            seen.add(candidate);
        }
        return candidate;
    });
}
function appendRawAiInteraction(record) {
    const at = new Date().toISOString();
    const date = at.slice(0, 10);
    const safeTraceId = record.traceId.replace(/[^A-Za-z0-9_-]/g, "_");
    const relativeFile = node_path_1.default.join(date, `${safeTraceId}.jsonl`);
    const target = node_path_1.default.join(paths_1.aiInteractionDir, relativeFile);
    const entry = { at, ...record };
    const serialized = serialize(entry);
    node_fs_1.default.mkdirSync(paths_1.aiInteractionDir, { recursive: true, mode: 0o700 });
    node_fs_1.default.chmodSync(paths_1.aiInteractionDir, 0o700);
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(target), { recursive: true, mode: 0o700 });
    node_fs_1.default.chmodSync(node_path_1.default.dirname(target), 0o700);
    node_fs_1.default.appendFileSync(target, `${serialized}\n`, { encoding: "utf8", mode: 0o600 });
    node_fs_1.default.appendFileSync(paths_1.aiInteractionIndex, `${serialize({
        at,
        traceId: record.traceId,
        provider: record.provider,
        model: record.model,
        direction: record.direction,
        file: relativeFile,
        bytes: Buffer.byteLength(serialized, "utf8"),
    })}\n`, { encoding: "utf8", mode: 0o600 });
}
