"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.REF_REVIVAL_KEYS = void 0;
exports.defaultReplayLimits = defaultReplayLimits;
exports.observationMarkerFromRef = observationMarkerFromRef;
exports.renderObservationMarker = renderObservationMarker;
exports.rehydrateAssetRef = rehydrateAssetRef;
exports.extractArtifactId = extractArtifactId;
exports.pngDimensions = pngDimensions;
exports.selectAssetsForReplay = selectAssetsForReplay;
/** Snapshot-bound browser-ref identity keys that a media reference must not carry. */
exports.REF_REVIVAL_KEYS = ["ref", "snapshotId", "targetId", "sessionId", "tabId"];
const DEFAULT_LIMITS = {
    maxHydratedScreenshots: 2,
    imageInputBudgetTokens: 6_000,
    maxRecentTurns: 3,
};
/** Merge caller/config overrides over the research defaults. */
function defaultReplayLimits(overrides) {
    return {
        maxHydratedScreenshots: overrides?.maxHydratedScreenshots ?? DEFAULT_LIMITS.maxHydratedScreenshots,
        imageInputBudgetTokens: overrides?.imageInputBudgetTokens ?? DEFAULT_LIMITS.imageInputBudgetTokens,
        maxRecentTurns: overrides?.maxRecentTurns ?? DEFAULT_LIMITS.maxRecentTurns,
    };
}
/** Build a replay marker from an asset reference at the requested detail level. */
function observationMarkerFromRef(ref, detail) {
    const marker = {
        kind: "media-asset",
        detail,
        assetId: ref.assetId,
        mimeType: ref.mimeType,
    };
    if (detail === "full") {
        if (ref.width !== undefined)
            marker.width = ref.width;
        if (ref.height !== undefined)
            marker.height = ref.height;
        if (ref.observationSummary)
            marker.observationSummary = ref.observationSummary;
    }
    return marker;
}
/**
 * Render an informative text marker that replaces processed old media in the
 * replay view. The marker is plain text and never carries browser-ref identity.
 */
function renderObservationMarker(marker) {
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
function rehydrateAssetRef(input) {
    const ref = {
        assetId: input.assetId,
        mimeType: input.mimeType,
        sha256: input.sha256,
        byteSize: input.byteSize,
    };
    if (input.width !== undefined)
        ref.width = input.width;
    if (input.height !== undefined)
        ref.height = input.height;
    if (input.observationSummary)
        ref.observationSummary = input.observationSummary;
    return ref;
}
/** Detect an artifact id embedded in a tool result payload. Tool results carry
 *  it nested under `data` (e.g. `{ data: { artifactId } }`); a top-level id is
 *  also accepted for resilience. */
function extractArtifactId(result) {
    const fromObject = (obj) => {
        if (!obj || typeof obj !== "object" || Array.isArray(obj))
            return undefined;
        const candidate = obj.artifactId;
        return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
    };
    return fromObject(result) ?? fromObject(result?.data);
}
/** Parse PNG width/height from the IHDR chunk. Returns undefined for non-PNG. */
function pngDimensions(bytes) {
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 24 || bytes.subarray(0, 8).equals(PNG_SIGNATURE) === false)
        return undefined;
    // IHDR sits immediately after the 8-byte signature: width at +16, height at +20.
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}
/**
 * Decide how richly each asset is replayed, given the configured budget. The N
 * most recent positions (end of the ordered list) hydrate as "full"; everything
 * older is reduced to "minimal". Pure and deterministic for a given order.
 */
function selectAssetsForReplay(refs, limits) {
    const budget = Math.max(0, Math.floor(limits.maxHydratedScreenshots));
    const firstFull = refs.length - budget;
    return refs.map((_, index) => (index >= firstFull ? "full" : "minimal"));
}
