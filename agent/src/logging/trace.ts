import crypto from "node:crypto";

export function generateTraceId(): string {
  return `tr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}
