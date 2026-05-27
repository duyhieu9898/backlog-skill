"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateTraceId = generateTraceId;
const node_crypto_1 = __importDefault(require("node:crypto"));
function generateTraceId() {
    return `tr_${Date.now().toString(36)}_${node_crypto_1.default.randomBytes(4).toString("hex")}`;
}
