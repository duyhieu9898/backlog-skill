import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { artifactDir } from "../config/paths";
import { deleteArtifact, getArtifact, insertArtifact, listExpiredArtifacts, markArtifactDelivered, nowIso, type ArtifactRow } from "../storage/repositories";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

export type Artifact = ArtifactRow;

export class ArtifactStore {
  constructor(private readonly root = artifactDir) {}

  create(input: { ownerChatId: string; sourceTraceId: string; mimeType: string; bytes: Buffer; ttlMs?: number }): Artifact {
    if (!ALLOWED_MIME.has(input.mimeType)) throw new Error(`Unsupported artifact MIME type: ${input.mimeType}`);
    if (!input.bytes.length || input.bytes.length > MAX_BYTES) throw new Error("Artifact size is outside the allowed range.");
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const localPath = path.join(this.root, id);
    fs.writeFileSync(localPath, input.bytes, { mode: 0o600 });
    const row: Artifact = { id, owner_chat_id: input.ownerChatId, source_trace_id: input.sourceTraceId, mime_type: input.mimeType, byte_size: input.bytes.length, sha256, local_path: localPath, expires_at: new Date(Date.now() + (input.ttlMs ?? 15 * 60 * 1000)).toISOString(), delivered_at: null, created_at: nowIso() };
    insertArtifact(row);
    return row;
  }

  claim(id: string, ownerChatId: string): Artifact {
    const row = getArtifact(id);
    if (!row || row.owner_chat_id !== ownerChatId || row.delivered_at || row.expires_at <= nowIso() || !fs.existsSync(row.local_path)) throw new Error("Artifact is unavailable.");
    return row;
  }

  markDelivered(id: string): void {
    const row = getArtifact(id);
    if (row) fs.rmSync(row.local_path, { force: true });
    markArtifactDelivered(id);
  }

  cleanupExpired(): number {
    const rows = listExpiredArtifacts();
    for (const row of rows) { fs.rmSync(row.local_path, { force: true }); deleteArtifact(row.id); }
    return rows.length;
  }
}
