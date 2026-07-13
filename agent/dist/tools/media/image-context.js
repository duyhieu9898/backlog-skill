"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_MODEL_IMAGE_BYTES = void 0;
exports.createModelImage = createModelImage;
const node_crypto_1 = __importDefault(require("node:crypto"));
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);
exports.MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
/** Bounded, provider-neutral image payload for an immediately following model turn. */
function createModelImage(bytes, mimeType) {
    if (!ALLOWED_IMAGE_MIME.has(mimeType))
        throw new Error(`Unsupported model image MIME type: ${mimeType}`);
    if (!bytes.length || bytes.length > exports.MAX_MODEL_IMAGE_BYTES)
        throw new Error("Model image is outside the allowed size.");
    return {
        mimeType: mimeType,
        base64: bytes.toString("base64"),
        identity: node_crypto_1.default.createHash("sha256").update(bytes).digest("hex"),
        byteSize: bytes.length,
    };
}
