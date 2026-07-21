import {
  validateBrowserActionRequest,
  type BrowserActionRequest,
  type BrowserActionOutcome,
  type MutationMagnitude,
} from "./types";
import type { BrowserErrorRecovery, BrowserErrorCode } from "./errors";

export { validateBrowserActionRequest };

/**
 * Single normalization choke point for the provider-facing browser envelope.
 * Both the provider-envelope path (tool-executor dispatch) and the runtime
 * path (ActionExecutor) route raw input through here, so provider validation
 * and runtime validation reject the same malformed actions before execution
 * (US-027 AC). The flat envelope mirrors the `browser` tool shape: a
 * top-level `action` plus a nested `request` describing the act variant.
 */
export function normalizeActionEnvelope(raw: unknown): { action: string; request: BrowserActionRequest } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Browser act request must be an object.");
  }
  const value = raw as Record<string, unknown>;
  const action = typeof value.action === "string" ? value.action : "act";
  const request = validateBrowserActionRequest(value.request);
  return { action, request };
}

/**
 * Pure outcome classifier. Derives mutation magnitude and ref freshness from
 * pre/post navigation signals observed around a ref/snapshot action. Used to
 * give the model structured `BrowserActionOutcome` feedback.
 */
export function classifyOutcome(input: {
  kind: BrowserActionRequest["kind"];
  navigated?: boolean;
  frameNavigated?: boolean;
  tabReplaced?: boolean;
  majorDomChange?: boolean;
}): BrowserActionOutcome {
  let mutationMagnitude: MutationMagnitude;
  if (input.tabReplaced) mutationMagnitude = "tab-replacement";
  else if (input.navigated) mutationMagnitude = "navigation";
  else if (input.frameNavigated) mutationMagnitude = "frame-navigation";
  else if (input.majorDomChange) mutationMagnitude = "major-dom";
  else if (input.kind === "click" || input.kind === "fill" || input.kind === "type" || input.kind === "select") {
    mutationMagnitude = "minor-dom";
  } else {
    mutationMagnitude = "none";
  }

  const refFreshness = mutationMagnitude === "none" || mutationMagnitude === "minor-dom" ? "possibly-stale" : "invalid";
  const nextSnapshotRequired =
    mutationMagnitude === "navigation" ||
    mutationMagnitude === "major-dom" ||
    mutationMagnitude === "tab-replacement" ||
    mutationMagnitude === "frame-navigation";
  return { mutationMagnitude, refFreshness, nextSnapshotRequired };
}

/** Build a structured recovery hint carried on a BrowserError. */
export function buildRecovery(code: BrowserErrorCode, reason: string): BrowserErrorRecovery {
  const requiresNewSnapshot: BrowserErrorCode[] = [
    "SNAPSHOT_NOT_FOUND",
    "SNAPSHOT_REQUIRED",
    "SNAPSHOT_TAB_MISMATCH",
    "SNAPSHOT_STALE_REVISION",
    "SNAPSHOT_EXPIRED",
    "REF_NOT_FOUND",
    "REF_NOT_ACTIONABLE",
    "REF_INVISIBLE",
    "REF_COVERED",
    "REF_DETACHED",
  ];
  return { requiresNewSnapshot: requiresNewSnapshot.includes(code), reason };
}
