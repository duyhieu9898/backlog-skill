"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionExecutor = void 0;
const ref_store_1 = require("./ref-store");
const errors_1 = require("./errors");
class ActionExecutor {
    async execute(page, targetId, request) {
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
            throw new errors_1.BrowserError("ACTION_FAILED", "Missing ref or snapshotId in action request", false);
        }
        const descriptor = ref_store_1.refStore.getRef(snapshotId, ref);
        if (!descriptor) {
            throw new errors_1.BrowserError("ELEMENT_NOT_FOUND", `Element reference "${ref}" not found in snapshot "${snapshotId}"`, false);
        }
        const latestSnapshotId = ref_store_1.refStore.getLatestSnapshotId(targetId);
        const isStale = latestSnapshotId !== snapshotId;
        let locator = page.getByRole(descriptor.role, { name: descriptor.name, exact: true });
        // Check count on page
        let count = 0;
        try {
            count = await locator.count();
        }
        catch (err) {
            throw new errors_1.BrowserError("ACTION_FAILED", `Failed to resolve element count: ${err instanceof Error ? err.message : String(err)}`, false);
        }
        if (count === 0) {
            // Try non-exact match as a fallback
            locator = page.getByRole(descriptor.role, { name: descriptor.name });
            count = await locator.count();
        }
        if (isStale) {
            // Stale Ref Fallback resolution
            if (count === 0) {
                throw new errors_1.BrowserError("ELEMENT_NOT_FOUND", `Stale element reference "${ref}" was not found on the page.`, false);
            }
            if (count > 1) {
                throw new errors_1.BrowserError("STALE_ELEMENT_REF", `Stale element reference "${ref}" matched multiple elements (${count}) on the page.`, true);
            }
            // If count is exactly 1, we allow the stale ref execution!
        }
        else {
            // Current Ref resolution
            if (count === 0) {
                throw new errors_1.BrowserError("ELEMENT_NOT_FOUND", `Element reference "${ref}" not found on the page.`, false);
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
                    if (typeof locator.pressSequentially === "function") {
                        await locator.pressSequentially(request.text, { delay: 50, timeout: 5000 });
                    }
                    else {
                        await locator.type(request.text, { delay: 50, timeout: 5000 });
                    }
                    break;
                case "select":
                    await locator.selectOption(request.value, { timeout: 5000 });
                    break;
                default:
                    throw new errors_1.BrowserError("NOT_IMPLEMENTED", `Action kind "${request.kind}" is not implemented`, false);
            }
        }
        catch (err) {
            if (err instanceof errors_1.BrowserError)
                throw err;
            throw new errors_1.BrowserError("ACTION_FAILED", `Action execution failed: ${err instanceof Error ? err.message : String(err)}`, false);
        }
    }
}
exports.ActionExecutor = ActionExecutor;
