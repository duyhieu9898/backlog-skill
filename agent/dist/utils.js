"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatDate = formatDate;
exports.tailLines = tailLines;
function formatDate(date = new Date()) {
    return date.toLocaleString("sv-SE", {
        timeZone: process.env.TZ || "Asia/Ho_Chi_Minh",
        hour12: false,
        timeZoneName: "short",
    });
}
function tailLines(text, maxLines) {
    return text.trim().split(/\r?\n/).slice(-maxLines).join("\n") || "(không có output)";
}
