export type BrowserErrorCode =
  | "BROWSER_NOT_RUNNING"
  | "PROFILE_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "TARGET_ID_MISMATCH"
  | "SNAPSHOT_NOT_FOUND"
  | "STALE_ELEMENT_REF"
  | "ELEMENT_NOT_FOUND"
  | "ACTION_TIMEOUT"
  | "NAVIGATION_BLOCKED"
  | "ACTION_REQUIRES_CONFIRMATION"
  | "SCREENSHOT_FAILED"
  | "NOT_IMPLEMENTED"
  | "ACTION_FAILED";

export class BrowserError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = "BrowserError";
  }
}
