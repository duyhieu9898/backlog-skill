"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BrowserCleanupSweeper = void 0;
const app_1 = require("../config/app");
const ref_store_1 = require("./ref-store");
const logger_1 = require("../logging/logger");
class BrowserCleanupSweeper {
    service;
    timer = null;
    sweepInProgress = false;
    traceId = "browser-cleanup";
    constructor(service) {
        this.service = service;
        this.service.sweeper = this;
    }
    start() {
        if (this.timer)
            return;
        const scheduleNext = () => {
            const config = (0, app_1.loadAgentConfig)();
            const sweepMinutes = config.browser?.cleanup?.sweepMinutes ?? 5;
            const intervalMs = sweepMinutes * 60 * 1000;
            this.timer = setTimeout(async () => {
                try {
                    await this.sweep();
                }
                catch (e) {
                    console.error("Cleanup sweep failed:", e);
                }
                if (this.timer) {
                    scheduleNext();
                }
            }, intervalMs);
            if (this.timer && typeof this.timer.unref === "function") {
                this.timer.unref();
            }
        };
        scheduleNext();
    }
    stop() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }
    async sweep() {
        if (this.sweepInProgress) {
            return {
                startedAt: Date.now(),
                completedAt: Date.now(),
                closedIdleTabs: [],
                closedQuotaTabs: [],
                skippedBusyTabs: [],
                deletedSnapshots: [],
                errors: [{ resourceType: "profile", resourceId: "sweeper", code: "OVERLAP", message: "Sweep already in progress" }],
            };
        }
        this.sweepInProgress = true;
        const startedAt = Date.now();
        logger_1.log.info(this.traceId, "browser.cleanup.started", { startedAt });
        const closedIdleTabs = [];
        const closedQuotaTabs = [];
        const skippedBusyTabs = [];
        const errors = [];
        try {
            const config = (0, app_1.loadAgentConfig)();
            const idleMinutes = config.browser?.cleanup?.idleMinutes ?? 30;
            const idleThresholdMs = idleMinutes * 60 * 1000;
            const maxTabs = config.browser?.cleanup?.maxTabsPerProfile ?? 10;
            const now = Date.now();
            const profileRegistry = this.service.getRegistry();
            const tabRegistry = this.service.getTabRegistry();
            const activeProfiles = profileRegistry.list();
            for (const p of activeProfiles) {
                if (p.status !== "running")
                    continue;
                // Get all tabs for this profile
                const tabs = tabRegistry.getAllRecords().filter(t => t.profile === p.name);
                // 1. Idle tab cleanup
                const idleEligible = tabs.filter(t => {
                    const isStale = now - t.lastUsedAt > idleThresholdMs;
                    const isBusy = t.activeOperationCount > 0;
                    if (isStale && isBusy) {
                        skippedBusyTabs.push(t.targetId);
                        logger_1.log.info(this.traceId, "browser.cleanup.tab_skipped_busy", { profileName: p.name, targetId: t.targetId, lastUsedAt: t.lastUsedAt });
                    }
                    return isStale && !isBusy && !t.closing && !t.closeRequested;
                });
                if (idleEligible.length > 0) {
                    // Sort by lastUsedAt ascending (oldest first)
                    idleEligible.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
                    for (const tab of idleEligible) {
                        // Protect the active tab if another eligible stale tab exists
                        if (tab.active) {
                            const hasOtherStale = idleEligible.some(t => !t.active);
                            if (hasOtherStale) {
                                continue;
                            }
                        }
                        try {
                            await this.service.close(p.name, tab.targetId);
                            closedIdleTabs.push(tab.targetId);
                            logger_1.log.info(this.traceId, "browser.cleanup.tab_closed", { profileName: p.name, targetId: tab.targetId, reason: "idle" });
                        }
                        catch (err) {
                            errors.push({ resourceType: "tab", resourceId: tab.targetId, code: err.code || "CLOSE_FAILED", message: err.message });
                        }
                    }
                }
                // Re-query tabs after idle closing
                const remainingTabs = tabRegistry.getAllRecords().filter(t => t.profile === p.name);
                // 2. Tab quota enforcement
                if (remainingTabs.length > maxTabs) {
                    const quotaEligible = remainingTabs.filter(t => t.activeOperationCount === 0 && !t.closing);
                    if (quotaEligible.length === 0) {
                        errors.push({
                            resourceType: "profile",
                            resourceId: p.name,
                            code: "TAB_QUOTA_DEFERRED",
                            message: `Quota enforcement deferred: ${remainingTabs.length} tabs open, but all eligible tabs are busy or closing`
                        });
                        logger_1.log.warn(this.traceId, "browser.cleanup.failed", { profileName: p.name, code: "TAB_QUOTA_DEFERRED" });
                        continue;
                    }
                    // Sort: prefer closing non-active tab, then oldest lastUsedAt, then oldest createdAt
                    quotaEligible.sort((a, b) => {
                        if (a.active !== b.active) {
                            return a.active ? 1 : -1;
                        }
                        return a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt;
                    });
                    const excessCount = remainingTabs.length - maxTabs;
                    const toClose = quotaEligible.slice(0, excessCount);
                    for (const tab of toClose) {
                        try {
                            await this.service.close(p.name, tab.targetId);
                            closedQuotaTabs.push(tab.targetId);
                            logger_1.log.info(this.traceId, "browser.cleanup.tab_closed", { profileName: p.name, targetId: tab.targetId, reason: "quota" });
                        }
                        catch (err) {
                            errors.push({ resourceType: "tab", resourceId: tab.targetId, code: err.code || "CLOSE_FAILED", message: err.message });
                        }
                    }
                }
            }
            // 3. Expired snapshots cleanup
            const deletedSnapshots = ref_store_1.refStore.pruneExpired();
            for (const snapId of deletedSnapshots) {
                logger_1.log.info(this.traceId, "browser.cleanup.snapshot_deleted", { snapshotId: snapId });
            }
            const completedAt = Date.now();
            logger_1.log.info(this.traceId, "browser.cleanup.completed", {
                durationMs: completedAt - startedAt,
                closedIdleTabsCount: closedIdleTabs.length,
                closedQuotaTabsCount: closedQuotaTabs.length,
                deletedSnapshotsCount: deletedSnapshots.length,
            });
            return {
                startedAt,
                completedAt,
                closedIdleTabs,
                closedQuotaTabs,
                skippedBusyTabs,
                deletedSnapshots,
                errors,
            };
        }
        catch (e) {
            logger_1.log.error(this.traceId, "browser.cleanup.failed", { error: e });
            throw e;
        }
        finally {
            this.sweepInProgress = false;
        }
    }
}
exports.BrowserCleanupSweeper = BrowserCleanupSweeper;
