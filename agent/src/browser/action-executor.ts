import type { Page } from "playwright";
import { refStore } from "./ref-store";
import { validateBrowserActionRequest, type BrowserActionRequest } from "./types";
import { BrowserError } from "./errors";
import { buildRecovery } from "./contract";

export class ActionExecutor {
  async execute(page: Page, targetId: string, request: BrowserActionRequest): Promise<void> {
    request = validateBrowserActionRequest(request);
    // 1. Handlers that do NOT require a locator ref:
    if (request.kind === "press") {
      await page.keyboard.press(request.key);
      return;
    }
    if (request.kind === "scroll") {
      const scrollAmount = request.amount !== undefined ? request.amount : 500;
      const scrollY = request.direction === "down" ? scrollAmount : -scrollAmount;
      await page.evaluate((y) => window.scrollBy(0, y), scrollY);
      return;
    }
    if (request.kind === "wait") {
      const ms = request.milliseconds !== undefined ? request.milliseconds : 1000;
      await page.waitForTimeout(ms);
      return;
    }

    // 2. Handlers that require a locator ref:
    const { ref, snapshotId } = request;
    if (!ref || !snapshotId) {
      throw new BrowserError("SNAPSHOT_REQUIRED", "Ref actions require both ref and snapshotId.", true);
    }

    const record = refStore.getRecord(snapshotId);
    if (!record) throw new BrowserError("SNAPSHOT_NOT_FOUND", `Snapshot "${snapshotId}" is unavailable or expired.`, true);
    if (record.targetId !== targetId) throw new BrowserError("SNAPSHOT_TAB_MISMATCH", "Snapshot belongs to a different browser tab.", true);
    const descriptor = refStore.getRef(snapshotId, ref);
    if (!descriptor) {
      throw new BrowserError("REF_NOT_FOUND", `Element reference "${ref}" not found in snapshot "${snapshotId}"`, true);
    }

    const latestSnapshotId = refStore.getLatestSnapshotId(targetId);
    if (latestSnapshotId !== snapshotId) {
      throw new BrowserError("SNAPSHOT_STALE_REVISION", "A newer snapshot exists; capture a fresh snapshot before acting.", true, buildRecovery("SNAPSHOT_STALE_REVISION", "a newer snapshot exists"));
    }

    // Document-generation gate: navigation bumps the tab's generation, so a
    // snapshot taken before navigation is stale even if it is still the latest
    // id. This is the core US-027 silent-rebind fix — a ref must never resolve
    // against a document other than the one that produced it.
    if (record.documentRevision !== refStore.getCurrentGeneration(targetId)) {
      throw new BrowserError("SNAPSHOT_STALE_REVISION", "The page navigated after this snapshot was captured; capture a fresh snapshot before acting.", true, buildRecovery("SNAPSHOT_STALE_REVISION", "document changed since snapshot"));
    }

    const locator = page.getByRole(descriptor.role as any, { name: descriptor.name, exact: true });

    // Check count on page. No exact→non-exact fallback: a within-snapshot
    // non-exact match would silently rebind the ref to a different element,
    // which violates the snapshot-bound contract (ADR-0020).
    let count = 0;
    try {
      count = await locator.count();
    } catch (err) {
      throw new BrowserError("ACTION_FAILED", `Failed to resolve element count: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    if (count === 0) {
      throw new BrowserError("REF_NOT_ACTIONABLE", `Element reference "${ref}" is no longer actionable on the current document.`, true, buildRecovery("REF_NOT_ACTIONABLE", "role/name not present on this document"));
    }
    if (count > 1) {
      throw new BrowserError("REF_NOT_ACTIONABLE", `Element reference "${ref}" is ambiguous on the current document.`, true, buildRecovery("REF_NOT_ACTIONABLE", "role/name matches more than one element"));
    }

    // Perform target action
    try {
      switch (request.kind) {
        case "click":
          await locator.click({ timeout: 5000 });
          break;
        case "fill":
          await locator.fill(request.value, { timeout: 5000 });
          break;
        case "type":
          if (typeof (locator as any).pressSequentially === "function") {
            await (locator as any).pressSequentially(request.text, { delay: 50, timeout: 5000 });
          } else {
            await locator.type(request.text, { delay: 50, timeout: 5000 });
          }
          break;
        case "select":
          await locator.selectOption(request.value, { timeout: 5000 });
          break;
        default:
          throw new BrowserError("NOT_IMPLEMENTED", `Action kind "${(request as any).kind}" is not implemented`, false);
      }
    } catch (err) {
      if (err instanceof BrowserError) throw err;
      throw new BrowserError("ACTION_FAILED", `Action execution failed: ${err instanceof Error ? err.message : String(err)}`, false);
    }
  }
}
