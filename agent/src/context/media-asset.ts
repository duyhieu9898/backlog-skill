// US-027 mảng 4 — media replay / asset marker (ADR-0020, research §178-204).
//
// Media from tool artifacts is persisted once as a lightweight asset reference
// (hash + dimensions) and never repeated as base64 on every turn. Processed old
// media is represented in the replay view by an informative text marker;
// rehydration restores metadata only and NEVER revives a snapshot-bound browser
// ref (a ref stays actionable only through a fresh snapshot — see ADR-0020).
//
// Replay budgets (hydrated screenshot count, image-input token budget, recent
// turn bound) are config-driven, measurable values — not hard-coded constants.

/** Snapshot-bound browser-ref identity keys that a media reference must not carry. */
export const REF_REVIVAL_KEYS = ["ref", "snapshotId", "targetId", "sessionId", "tabId"] as const;

/**
 * Metadata-only reference to a persisted media asset. Deliberately omits byte
 * payload (`local_path`/base64) and any browser-ref authority. This is what the
 * durable transcript and replay view carry; the asset's bytes live in the
 * artifact store and are hydrated only for the current/recent turn.
 */
export type MediaAssetRef = {
  assetId: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  width?: number;
  height?: number;
  observationSummary?: string;
};

/** How richly a replayed asset is represented. "full" keeps dimensions + the
 *  persisted visual observation; "minimal" drops them to bound replay cost. */
export type ReplayDetail = "full" | "minimal";

export type ObservationMarker = {
  kind: "media-asset";
  detail: ReplayDetail;
  assetId: string;
  mimeType: string;
  width?: number;
  height?: number;
  observationSummary?: string;
};

/** Configurable, measurable replay budgets. Defaults follow research §190-203. */
export type ReplayLimits = {
  /** At most this many recent screenshots hydrate with a full marker. */
  maxHydratedScreenshots: number;
  /** Bounded image-input token budget for a single model call (research §190). */
  imageInputBudgetTokens: number;
  /** How many recent completed turns keep rich media context (research §190). */
  maxRecentTurns: number;
};

const DEFAULT_LIMITS: ReplayLimits = {
  maxHydratedScreenshots: 2,
  imageInputBudgetTokens: 6_000,
  maxRecentTurns: 3,
};

/** Merge caller/config overrides over the research defaults. */
export function defaultReplayLimits(overrides?: {
  maxHydratedScreenshots?: number;
  imageInputBudgetTokens?: number;
  maxRecentTurns?: number;
}): ReplayLimits {
  return {
    maxHydratedScreenshots: overrides?.maxHydratedScreenshots ?? DEFAULT_LIMITS.maxHydratedScreenshots,
    imageInputBudgetTokens: overrides?.imageInputBudgetTokens ?? DEFAULT_LIMITS.imageInputBudgetTokens,
    maxRecentTurns: overrides?.maxRecentTurns ?? DEFAULT_LIMITS.maxRecentTurns,
  };
}

/** Build a replay marker from an asset reference at the requested detail level. */
export function observationMarkerFromRef(ref: MediaAssetRef, detail: ReplayDetail): ObservationMarker {
  const marker: ObservationMarker = {
    kind: "media-asset",
    detail,
    assetId: ref.assetId,
    mimeType: ref.mimeType,
  };
  if (detail === "full") {
    if (ref.width !== undefined) marker.width = ref.width;
    if (ref.height !== undefined) marker.height = ref.height;
    if (ref.observationSummary) marker.observationSummary = ref.observationSummary;
  }
  return marker;
}

/**
 * Render an informative text marker that replaces processed old media in the
 * replay view. The marker is plain text and never carries browser-ref identity.
 */
export function renderObservationMarker(marker: ObservationMarker): string {
  if (marker.detail === "minimal") {
    return `[PROCESSED MEDIA ASSET] id=${marker.assetId} mime=${marker.mimeType} (metadata pruned from replay)`;
  }
  const dims = marker.width !== undefined && marker.height !== undefined
    ? `${marker.width}x${marker.height}`
    : "dimensions-unknown";
  const observed = marker.observationSummary ? `\nObservation: ${marker.observationSummary}` : "";
  return `[PROCESSED MEDIA ASSET] id=${marker.assetId} mime=${marker.mimeType} dimensions=${dims}${observed}`;
}

/**
 * Rehydrate a metadata-only asset reference. Whitelists metadata fields only, so
 * a rehydrated reference can never carry snapshot-bound browser-ref authority
 * even if a caller feeds it extra identity keys (ADR-0020).
 */
export function rehydrateAssetRef(input: MediaAssetRef): MediaAssetRef {
  const ref: MediaAssetRef = {
    assetId: input.assetId,
    mimeType: input.mimeType,
    sha256: input.sha256,
    byteSize: input.byteSize,
  };
  if (input.width !== undefined) ref.width = input.width;
  if (input.height !== undefined) ref.height = input.height;
  if (input.observationSummary) ref.observationSummary = input.observationSummary;
  return ref;
}

/** Detect an artifact id embedded in a tool result payload. Tool results carry
 *  it nested under `data` (e.g. `{ data: { artifactId } }`); a top-level id is
 *  also accepted for resilience. */
export function extractArtifactId(result: unknown): string | undefined {
  const fromObject = (obj: unknown): string | undefined => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const candidate = (obj as { artifactId?: unknown }).artifactId;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
  };
  return fromObject(result) ?? fromObject((result as { data?: unknown } | null | undefined)?.data);
}

/** Parse PNG width/height from the IHDR chunk. Returns undefined for non-PNG. */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || bytes.subarray(0, 8).equals(PNG_SIGNATURE) === false) return undefined;
  // IHDR sits immediately after the 8-byte signature: width at +16, height at +20.
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Decide how richly each asset is replayed, given the configured budget. The N
 * most recent positions (end of the ordered list) hydrate as "full"; everything
 * older is reduced to "minimal". Pure and deterministic for a given order.
 */
export function selectAssetsForReplay(refs: MediaAssetRef[], limits: ReplayLimits): ReplayDetail[] {
  const budget = Math.max(0, Math.floor(limits.maxHydratedScreenshots));
  const firstFull = refs.length - budget;
  return refs.map((_, index) => (index >= firstFull ? "full" : "minimal"));
}
