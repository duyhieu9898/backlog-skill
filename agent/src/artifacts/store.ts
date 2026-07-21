import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { artifactDir } from "../config/paths";
import { deleteArtifact, getArtifact, getArtifactByHash, getArtifactMetadata, insertArtifact, listExpiredArtifacts, markArtifactDelivered, nowIso, type ArtifactRow } from "../storage/repositories";
import { pngDimensions, rehydrateAssetRef, type MediaAssetRef } from "../context/media-asset";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "application/pdf", "text/plain"]);

export type Artifact = ArtifactRow;

export class ArtifactStore {
  constructor(private readonly root = artifactDir) {}

  create(input: {
    ownerChatId: string;
    sourceTraceId: string;
    mimeType: string;
    bytes: Buffer;
    ttlMs?: number;
    width?: number;
    height?: number;
    observationSummary?: string;
  }): Artifact {
    if (!ALLOWED_MIME.has(input.mimeType)) throw new Error(`Unsupported artifact MIME type: ${input.mimeType}`);
    if (!input.bytes.length || input.bytes.length > MAX_BYTES) throw new Error("Artifact size is outside the allowed range.");
    const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");

    // US-027 mảng 4: persist media once. Identical content (same hash, same
    // owner, still available) reuses the existing asset instead of storing a
    // duplicate byte payload (research §182).
    const existing = getArtifactByHash(sha256, input.ownerChatId);
    if (existing) return existing;

    // Dimensions: prefer explicit values, else read them from a PNG header so
    // every screenshot artifact carries replay metadata with no caller change.
    let width = input.width;
    let height = input.height;
    if ((width === undefined || height === undefined) && input.mimeType === "image/png") {
      const dims = pngDimensions(input.bytes);
      if (dims) {
        if (width === undefined) width = dims.width;
        if (height === undefined) height = dims.height;
      }
    }

    const id = crypto.randomUUID();
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const localPath = path.join(this.root, id);
    fs.writeFileSync(localPath, input.bytes, { mode: 0o600 });
    const row: Artifact = {
      id,
      owner_chat_id: input.ownerChatId,
      source_trace_id: input.sourceTraceId,
      mime_type: input.mimeType,
      byte_size: input.bytes.length,
      sha256,
      local_path: localPath,
      expires_at: new Date(Date.now() + (input.ttlMs ?? 15 * 60 * 1000)).toISOString(),
      delivered_at: null,
      created_at: nowIso(),
      width: width ?? null,
      height: height ?? null,
      observation_summary: input.observationSummary ?? null,
    };
    insertArtifact(row);
    return row;
  }

  claim(id: string, ownerChatId: string): Artifact {
    const row = getArtifact(id);
    if (!row || row.owner_chat_id !== ownerChatId || row.delivered_at || row.expires_at <= nowIso() || !fs.existsSync(row.local_path)) throw new Error("Artifact is unavailable.");
    return row;
  }

  /**
   * Rehydrate a metadata-only asset reference by id. Works after `markDelivered`
   * (bytes pruned) because it reads the durable metadata row, not the bytes.
   * The returned reference never carries browser-ref authority (ADR-0020).
   */
  getMetadata(id: string): MediaAssetRef | null {
    const meta = getArtifactMetadata(id);
    if (!meta) return null;
    return rehydrateAssetRef({
      assetId: meta.id,
      mimeType: meta.mime_type,
      sha256: meta.sha256,
      byteSize: meta.byte_size,
      ...(meta.width !== null ? { width: meta.width } : {}),
      ...(meta.height !== null ? { height: meta.height } : {}),
      ...(meta.observation_summary ? { observationSummary: meta.observation_summary } : {}),
    });
  }

  markDelivered(id: string): void {
    const row = getArtifact(id);
    if (row) fs.rmSync(row.local_path, { force: true });
    // The metadata row is intentionally retained (only the bytes are pruned) so
    // the asset stays queryable for audit and replay-by-asset-id (US-027 mảng 4).
    markArtifactDelivered(id);
  }

  cleanupExpired(): number {
    const rows = listExpiredArtifacts();
    for (const row of rows) { fs.rmSync(row.local_path, { force: true }); deleteArtifact(row.id); }
    return rows.length;
  }
}
