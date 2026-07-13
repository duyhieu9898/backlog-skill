import crypto from "node:crypto";

const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg"]);
export const MAX_MODEL_IMAGE_BYTES = 5 * 1024 * 1024;

export type ModelImage = {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  identity: string;
  byteSize: number;
};

/** Bounded, provider-neutral image payload for an immediately following model turn. */
export function createModelImage(bytes: Buffer, mimeType: string): ModelImage {
  if (!ALLOWED_IMAGE_MIME.has(mimeType)) throw new Error(`Unsupported model image MIME type: ${mimeType}`);
  if (!bytes.length || bytes.length > MAX_MODEL_IMAGE_BYTES) throw new Error("Model image is outside the allowed size.");
  return {
    mimeType: mimeType as ModelImage["mimeType"],
    base64: bytes.toString("base64"),
    identity: crypto.createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.length,
  };
}
