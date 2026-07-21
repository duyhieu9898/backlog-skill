"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generalRoute = generalRoute;
exports.resolveCapabilityRoute = resolveCapabilityRoute;
const FILE_READ = ["file", "tệp", "thư mục", "folder", "directory", "đọc", "read", "list"];
const FILE_WRITE = ["write", "ghi", "sửa", "patch", "create file", "tạo file", "mkdir"];
const WEB = ["http://", "https://", "website", "trang web", "web ", "browser"];
const DESKTOP = ["desktop", "màn hình", "screenshot", "chụp màn hình", "vscode", "vs code", "visual studio code", "app "];
const DESKTOP_CONTROL = ["click", "nhấp", "bấm", "type", "gõ", "press", "key", "mở app", "launch"];
const COMMAND = ["run command", "chạy lệnh", "shell command", "terminal command"];
const CONTINUATION = ["nó", "cái thứ", "tiếp", "continue", "it", "that", "sửa nó", "click"];
const GENERAL = ["là gì", "what is", "who are", "bạn là ai", "giải thích", "explain"];
const CANCEL = ["cancel", "hủy", "/stop", "dừng"];
const TTL_MS = 15 * 60 * 1000;
function has(text, words) { return words.some((word) => text.includes(word)); }
function unique(items) { return [...new Set(items)]; }
function generalRoute(reason, continuation = "new") {
    return { capabilities: [], targets: [], continuation, confidence: "low", selectionReason: reason };
}
function resolveCapabilityRoute(input) {
    const text = input.text.toLowerCase();
    const now = input.now || new Date();
    const expired = input.activeLease && new Date(input.activeLease.expiresAt).getTime() <= now.getTime();
    if (has(text, CANCEL))
        return { route: generalRoute("explicit cancellation", "cleared"), lease: null };
    if (has(text, GENERAL) && !has(text, [...FILE_READ, ...WEB, ...DESKTOP, ...COMMAND]))
        return { route: generalRoute("self-contained general question", "cleared"), lease: null };
    let capabilities = [];
    let reason = "unresolved request";
    let confidence = "low";
    let skillSlug = input.skillSlug;
    if (skillSlug) {
        capabilities = ["skill"];
        reason = "selected skill";
        confidence = "hard-signal";
    }
    else if (has(text, FILE_WRITE)) {
        capabilities = ["file-write", "file-read"];
        reason = "explicit file write";
        confidence = "hard-signal";
    }
    else if (has(text, FILE_READ)) {
        capabilities = ["file-read"];
        reason = "explicit file read";
        confidence = "hard-signal";
    }
    else if (has(text, WEB)) {
        capabilities = ["web"];
        reason = "explicit web request";
        confidence = "hard-signal";
    }
    else if (has(text, DESKTOP)) {
        capabilities = [has(text, DESKTOP_CONTROL) ? "desktop-control" : "desktop-observe"];
        reason = "explicit desktop request";
        confidence = "hard-signal";
    }
    else if (has(text, COMMAND)) {
        capabilities = ["command"];
        reason = "explicit command request";
        confidence = "hard-signal";
    }
    else if (!expired && input.activeLease && has(text, CONTINUATION)) {
        capabilities = input.activeLease.capabilities;
        skillSlug = input.activeLease.skillSlug;
        reason = "active scope continuation";
        confidence = "lease";
    }
    if (!capabilities.length)
        return { route: generalRoute(reason, expired ? "cleared" : "new"), lease: expired ? null : input.activeLease || null };
    capabilities = unique(capabilities).slice(0, 2);
    const route = { capabilities, targets: [], continuation: confidence === "lease" ? "continued" : "new", confidence, selectionReason: reason, ...(skillSlug ? { skillSlug } : {}) };
    return { route, lease: { capabilities, targets: [], taskSummary: reason, sourceTurn: input.traceId, state: "active", expiresAt: new Date(now.getTime() + TTL_MS).toISOString(), ...(skillSlug ? { skillSlug } : {}) } };
}
