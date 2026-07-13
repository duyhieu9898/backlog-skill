import type { Page } from "playwright";
import { refStore } from "./ref-store";
import type { BrowserActionRequest } from "./types";
import { BrowserError } from "./errors";

export class ActionExecutor {
  async execute(page: Page, targetId: string, request: BrowserActionRequest): Promise<void> {
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
      throw new BrowserError("ACTION_FAILED", "Missing ref or snapshotId in action request", false);
    }

    const descriptor = refStore.getRef(snapshotId, ref);
    if (!descriptor) {
      throw new BrowserError("ELEMENT_NOT_FOUND", `Element reference "${ref}" not found in snapshot "${snapshotId}"`, false);
    }

    const latestSnapshotId = refStore.getLatestSnapshotId(targetId);
    const isStale = latestSnapshotId !== snapshotId;

    let locator = page.getByRole(descriptor.role as any, { name: descriptor.name, exact: true });
    
    // Check count on page
    let count = 0;
    try {
      count = await locator.count();
    } catch (err) {
      throw new BrowserError("ACTION_FAILED", `Failed to resolve element count: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    if (count === 0) {
      // Try non-exact match as a fallback
      locator = page.getByRole(descriptor.role as any, { name: descriptor.name });
      count = await locator.count();
    }

    if (isStale) {
      // Stale Ref Fallback resolution
      if (count === 0) {
        throw new BrowserError("ELEMENT_NOT_FOUND", `Stale element reference "${ref}" was not found on the page.`, false);
      }
      if (count > 1) {
        throw new BrowserError("STALE_ELEMENT_REF", `Stale element reference "${ref}" matched multiple elements (${count}) on the page.`, true);
      }
      // If count is exactly 1, we allow the stale ref execution!
    } else {
      // Current Ref resolution
      if (count === 0) {
        throw new BrowserError("ELEMENT_NOT_FOUND", `Element reference "${ref}" not found on the page.`, false);
      }
      if (count > 1) {
        // Ambiguous match, choose first to prevent crash
        locator = locator.first();
      }
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
