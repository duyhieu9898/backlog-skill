"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ActionExecutor = void 0;
const ref_store_1 = require("./ref-store");
const types_1 = require("./types");
const errors_1 = require("./errors");
const contract_1 = require("./contract");
class ActionExecutor {
    async execute(page, targetId, request) {
        request = (0, types_1.validateBrowserActionRequest)(request);
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
            throw new errors_1.BrowserError("SNAPSHOT_REQUIRED", "Ref actions require both ref and snapshotId.", true);
        }
        const record = ref_store_1.refStore.getRecord(snapshotId);
        if (!record)
            throw new errors_1.BrowserError("SNAPSHOT_NOT_FOUND", `Snapshot "${snapshotId}" is unavailable or expired.`, true);
        if (record.targetId !== targetId)
            throw new errors_1.BrowserError("SNAPSHOT_TAB_MISMATCH", "Snapshot belongs to a different browser tab.", true);
        const descriptor = ref_store_1.refStore.getRef(snapshotId, ref);
        if (!descriptor) {
            throw new errors_1.BrowserError("REF_NOT_FOUND", `Element reference "${ref}" not found in snapshot "${snapshotId}"`, true);
        }
        const latestSnapshotId = ref_store_1.refStore.getLatestSnapshotId(targetId);
        if (latestSnapshotId !== snapshotId) {
            throw new errors_1.BrowserError("SNAPSHOT_STALE_REVISION", "A newer snapshot exists; capture a fresh snapshot before acting.", true, (0, contract_1.buildRecovery)("SNAPSHOT_STALE_REVISION", "a newer snapshot exists"));
        }
        // Document-generation gate: navigation bumps the tab's generation, so a
        // snapshot taken before navigation is stale even if it is still the latest
        // id. This is the core US-027 silent-rebind fix — a ref must never resolve
        // against a document other than the one that produced it.
        if (record.documentRevision !== ref_store_1.refStore.getCurrentGeneration(targetId)) {
            throw new errors_1.BrowserError("SNAPSHOT_STALE_REVISION", "The page navigated after this snapshot was captured; capture a fresh snapshot before acting.", true, (0, contract_1.buildRecovery)("SNAPSHOT_STALE_REVISION", "document changed since snapshot"));
        }
        const locator = page.getByRole(descriptor.role, { name: descriptor.name, exact: true });
        // Check count on page. No exact→non-exact fallback: a within-snapshot
        // non-exact match would silently rebind the ref to a different element,
        // which violates the snapshot-bound contract (ADR-0020).
        let count = 0;
        try {
            count = await locator.count();
        }
        catch (err) {
            throw new errors_1.BrowserError("ACTION_FAILED", `Failed to resolve element count: ${err instanceof Error ? err.message : String(err)}`, false);
        }
        if (count === 0) {
            throw new errors_1.BrowserError("REF_NOT_ACTIONABLE", `Element reference "${ref}" is no longer actionable on the current document.`, true, (0, contract_1.buildRecovery)("REF_NOT_ACTIONABLE", "role/name not present on this document"));
        }
        if (count > 1) {
            throw new errors_1.BrowserError("REF_NOT_ACTIONABLE", `Element reference "${ref}" is ambiguous on the current document.`, true, (0, contract_1.buildRecovery)("REF_NOT_ACTIONABLE", "role/name matches more than one element"));
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
