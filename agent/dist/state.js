"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.readOffset = readOffset;
exports.writeOffset = writeOffset;
const repositories_1 = require("./storage/repositories");
function readOffset() {
    const state = (0, repositories_1.getJsonState)("kv_state", "telegram.offset");
    return state?.offset ?? null;
}
function writeOffset(offset) {
    (0, repositories_1.setJsonState)("kv_state", "telegram.offset", { offset });
}
