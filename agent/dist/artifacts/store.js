"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ArtifactStore = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("../config/paths");
const repositories_1 = require("../storage/repositories");
const media_asset_1 = require("../context/media-asset");
const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);
class ArtifactStore {
    root;
    constructor(root = paths_1.artifactDir) {
        this.root = root;
    }
    create(input) {
        if (!ALLOWED_MIME.has(input.mimeType))
            throw new Error(`Unsupported artifact MIME type: ${input.mimeType}`);
        if (!input.bytes.length || input.bytes.length > MAX_BYTES)
            throw new Error("Artifact size is outside the allowed range.");
        const sha256 = node_crypto_1.default.createHash("sha256").update(input.bytes).digest("hex");
        // US-027 mảng 4: persist media once. Identical content (same hash, same
        // owner, still available) reuses the existing asset instead of storing a
        // duplicate byte payload (research §182).
        const existing = (0, repositories_1.getArtifactByHash)(sha256, input.ownerChatId);
        if (existing)
            return existing;
        // Dimensions: prefer explicit values, else read them from a PNG header so
        // every screenshot artifact carries replay metadata with no caller change.
        let width = input.width;
        let height = input.height;
        if ((width === undefined || height === undefined) && input.mimeType === "image/png") {
            const dims = (0, media_asset_1.pngDimensions)(input.bytes);
            if (dims) {
                if (width === undefined)
                    width = dims.width;
                if (height === undefined)
                    height = dims.height;
            }
        }
        const id = node_crypto_1.default.randomUUID();
        node_fs_1.default.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const localPath = node_path_1.default.join(this.root, id);
        node_fs_1.default.writeFileSync(localPath, input.bytes, { mode: 0o600 });
        const row = {
            id,
            owner_chat_id: input.ownerChatId,
            source_trace_id: input.sourceTraceId,
            mime_type: input.mimeType,
            byte_size: input.bytes.length,
            sha256,
            local_path: localPath,
            expires_at: new Date(Date.now() + (input.ttlMs ?? 15 * 60 * 1000)).toISOString(),
            delivered_at: null,
            created_at: (0, repositories_1.nowIso)(),
            width: width ?? null,
            height: height ?? null,
            observation_summary: input.observationSummary ?? null,
        };
        (0, repositories_1.insertArtifact)(row);
        return row;
    }
    claim(id, ownerChatId) {
        const row = (0, repositories_1.getArtifact)(id);
        if (!row || row.owner_chat_id !== ownerChatId || row.delivered_at || row.expires_at <= (0, repositories_1.nowIso)() || !node_fs_1.default.existsSync(row.local_path))
            throw new Error("Artifact is unavailable.");
        return row;
    }
    /**
     * Rehydrate a metadata-only asset reference by id. Works after `markDelivered`
     * (bytes pruned) because it reads the durable metadata row, not the bytes.
     * The returned reference never carries browser-ref authority (ADR-0020).
     */
    getMetadata(id) {
        const meta = (0, repositories_1.getArtifactMetadata)(id);
        if (!meta)
            return null;
        return (0, media_asset_1.rehydrateAssetRef)({
            assetId: meta.id,
            mimeType: meta.mime_type,
            sha256: meta.sha256,
            byteSize: meta.byte_size,
            ...(meta.width !== null ? { width: meta.width } : {}),
            ...(meta.height !== null ? { height: meta.height } : {}),
            ...(meta.observation_summary ? { observationSummary: meta.observation_summary } : {}),
        });
    }
    markDelivered(id) {
        const row = (0, repositories_1.getArtifact)(id);
        if (row)
            node_fs_1.default.rmSync(row.local_path, { force: true });
        // The metadata row is intentionally retained (only the bytes are pruned) so
        // the asset stays queryable for audit and replay-by-asset-id (US-027 mảng 4).
        (0, repositories_1.markArtifactDelivered)(id);
    }
    cleanupExpired() {
        const rows = (0, repositories_1.listExpiredArtifacts)();
        for (const row of rows) {
            node_fs_1.default.rmSync(row.local_path, { force: true });
            (0, repositories_1.deleteArtifact)(row.id);
        }
        return rows.length;
    }
}
exports.ArtifactStore = ArtifactStore;
