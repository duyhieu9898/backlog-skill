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
        const id = node_crypto_1.default.randomUUID();
        const sha256 = node_crypto_1.default.createHash("sha256").update(input.bytes).digest("hex");
        node_fs_1.default.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const localPath = node_path_1.default.join(this.root, id);
        node_fs_1.default.writeFileSync(localPath, input.bytes, { mode: 0o600 });
        const row = { id, owner_chat_id: input.ownerChatId, source_trace_id: input.sourceTraceId, mime_type: input.mimeType, byte_size: input.bytes.length, sha256, local_path: localPath, expires_at: new Date(Date.now() + (input.ttlMs ?? 15 * 60 * 1000)).toISOString(), delivered_at: null, created_at: (0, repositories_1.nowIso)() };
        (0, repositories_1.insertArtifact)(row);
        return row;
    }
    claim(id, ownerChatId) {
        const row = (0, repositories_1.getArtifact)(id);
        if (!row || row.owner_chat_id !== ownerChatId || row.delivered_at || row.expires_at <= (0, repositories_1.nowIso)() || !node_fs_1.default.existsSync(row.local_path))
            throw new Error("Artifact is unavailable.");
        return row;
    }
    markDelivered(id) {
        const row = (0, repositories_1.getArtifact)(id);
        if (row)
            node_fs_1.default.rmSync(row.local_path, { force: true });
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
