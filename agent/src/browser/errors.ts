export type BrowserErrorCode =
  | "BROWSER_NOT_RUNNING"
  | "PROFILE_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "TARGET_ID_MISMATCH"
  | "SNAPSHOT_NOT_FOUND"
  | "SNAPSHOT_REQUIRED"
  | "SNAPSHOT_TAB_MISMATCH"
  | "SNAPSHOT_STALE_REVISION"
  | "REF_NOT_FOUND"
  | "REF_NOT_ACTIONABLE"
  | "REF_INVISIBLE"
  | "REF_COVERED"
  | "REF_DETACHED"
  // Deprecated: never thrown; the live stale-ref code is SNAPSHOT_STALE_REVISION.
  // Kept in the union only to avoid churning persisted error payloads.
  | "STALE_ELEMENT_REF"
  | "ELEMENT_NOT_FOUND"
  | "ACTION_TIMEOUT"
  | "NAVIGATION_BLOCKED"
  | "ACTION_REQUIRES_CONFIRMATION"
  | "SCREENSHOT_FAILED"
  | "NOT_IMPLEMENTED"
  | "ACTION_FAILED"
  | "NAVIGATION_INVALID_URL"
  | "NAVIGATION_PROTOCOL_BLOCKED"
  | "NAVIGATION_PRIVATE_NETWORK_BLOCKED"
  | "NAVIGATION_HOST_NOT_ALLOWED"
  | "NAVIGATION_REDIRECT_BLOCKED"
  | "ACTION_CONTEXT_UNAVAILABLE"
  | "ACTION_TARGET_NOT_FOUND"
  | "ACTION_STALE_SNAPSHOT"
  | "ACTION_DENIED"
  | "CONFIRMATION_NOT_FOUND"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_STALE"
  | "CONFIRMATION_ALREADY_USED"
  | "CONFIRMATION_MISMATCH"
  | "PROFILE_INVALID_NAME"
  | "PROFILE_PATH_OUTSIDE_ROOT"
  | "PROFILE_ALREADY_IN_USE"
  | "PROFILE_START_IN_PROGRESS"
  | "PROFILE_START_FAILED"
  | "PROFILE_NOT_RUNNING"
  | "TAB_NOT_FOUND"
  | "TAB_BUSY"
  | "TAB_LIMIT_REACHED"
  | "TAB_CLOSE_FAILED"
  | "TAB_QUOTA_DEFERRED"
  | "SNAPSHOT_EXPIRED"
  | "BROWSER_SHUTTING_DOWN"
  | "BROWSER_SHUTDOWN_TIMEOUT"
  | "BROWSER_FORCE_KILL_FAILED";

export type BrowserErrorRecovery = {
  requiresNewSnapshot: boolean;
  reason: string;
};

export class BrowserError extends Error {
  readonly recovery?: BrowserErrorRecovery;
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
    public readonly retryable: boolean = false,
    recovery?: BrowserErrorRecovery
  ) {
    super(message);
    this.name = "BrowserError";
    this.recovery = recovery;
  }
}
