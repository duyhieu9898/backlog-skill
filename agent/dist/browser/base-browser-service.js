"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseBrowserService = void 0;
const tab_registry_1 = require("./tab-registry");
const store_1 = require("../artifacts/store");
const snapshot_service_1 = require("./snapshot-service");
const action_executor_1 = require("./action-executor");
const url_policy_1 = require("./url-policy");
const app_1 = require("../config/app");
const errors_1 = require("./errors");
const profile_registry_1 = require("./profile-registry");
const ref_store_1 = require("./ref-store");
class BaseBrowserService {
    profileRegistry = new profile_registry_1.ProfileRegistry();
    tabRegistry = new tab_registry_1.TabRegistry();
    snapshotService = new snapshot_service_1.SnapshotService();
    actionExecutor = new action_executor_1.ActionExecutor();
    shutdownStarted = false;
    shutdownPromise;
    sweeper;
    resolveProfileName(profileName) {
        if (profileName)
            return profileName;
        const config = (0, app_1.loadAgentConfig)();
        return config.browser?.defaultProfile || "agent";
    }
    async startProfile(profileName) {
        await this.start(profileName);
    }
    async shutdownProfile(profileName, options) {
        await this.stop(profileName, options);
    }
    isShuttingDown() {
        return this.shutdownStarted;
    }
    async enforceTabQuota(profileName) {
        const config = (0, app_1.loadAgentConfig)();
        const maxTabs = config.browser?.cleanup?.maxTabsPerProfile ?? 10;
        const tabs = this.tabRegistry.getAllRecords().filter(t => t.profile === profileName);
        if (tabs.length < maxTabs) {
            return;
        }
        const eligible = tabs.filter(t => t.activeOperationCount === 0 && !t.closing);
        if (eligible.length === 0) {
            throw new errors_1.BrowserError("TAB_LIMIT_REACHED", `Cannot open new tab: quota of ${maxTabs} reached and no tabs can be reclaimed`);
        }
        eligible.sort((a, b) => {
            if (a.active !== b.active) {
                return a.active ? 1 : -1;
            }
            return a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt;
        });
        const candidate = eligible[0];
        await this.close(profileName, candidate.targetId);
    }
    async listTabs(profileName) {
        const resolvedName = this.resolveProfileName(profileName);
        await this.ensureStarted(resolvedName);
        return this.tabRegistry.listWithTitles(resolvedName);
    }
    async open(profileName, url) {
        const config = (0, app_1.loadAgentConfig)();
        const allowedHosts = config.permissions?.browser?.allowedHosts || [];
        const decision = await (0, url_policy_1.evaluateUrl)({ url, allowedHosts });
        if (decision.decision === "deny") {
            throw new errors_1.BrowserError(decision.code, decision.reason);
        }
        if (this.shutdownStarted) {
            throw new errors_1.BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
        }
        const resolvedName = this.resolveProfileName(profileName);
        const context = await this.ensureStarted(resolvedName);
        // Reuse the active/blank tab if it exists and is at about:blank
        const activeTab = this.tabRegistry.getActive(resolvedName);
        if (activeTab && (activeTab.page.url() === "about:blank" || activeTab.page.url() === "")) {
            this.profileRegistry.markOperationStarted(resolvedName);
            const lease = this.tabRegistry.acquireLease(activeTab.targetId, resolvedName);
            try {
                await activeTab.page.goto(url, { waitUntil: "load", timeout: 30000 });
            }
            finally {
                lease.release();
                this.profileRegistry.markOperationFinished(resolvedName);
            }
            const title = await activeTab.page.title();
            return {
                targetId: activeTab.targetId,
                url: activeTab.page.url(),
                title,
                active: true,
            };
        }
        // Enforce limit
        await this.enforceTabQuota(resolvedName);
        const page = await context.newPage();
        const targetId = this.tabRegistry.register(page, context, resolvedName);
        this.profileRegistry.markOperationStarted(resolvedName);
        const lease = this.tabRegistry.acquireLease(targetId, resolvedName);
        try {
            await page.goto(url, { waitUntil: "load", timeout: 30000 });
        }
        finally {
            lease.release();
            this.profileRegistry.markOperationFinished(resolvedName);
        }
        const title = await page.title();
        return {
            targetId,
            url: page.url(),
            title,
            active: true,
        };
    }
    async executeTabOperation(profileName, targetId, operation) {
        if (this.shutdownStarted) {
            throw new errors_1.BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
        }
        const resolvedName = this.resolveProfileName(profileName);
        await this.ensureStarted(resolvedName);
        const tab = this.tabRegistry.get(targetId, resolvedName);
        if (!tab) {
            throw new errors_1.BrowserError("TAB_NOT_FOUND", `Tab ${targetId} not found in profile ${resolvedName}`);
        }
        if (tab.closing) {
            throw new errors_1.BrowserError("TAB_BUSY", `Tab ${targetId} is closing`);
        }
        this.profileRegistry.markOperationStarted(resolvedName);
        const lease = this.tabRegistry.acquireLease(targetId, resolvedName);
        try {
            return await operation(tab);
        }
        finally {
            lease.release();
            this.profileRegistry.markOperationFinished(resolvedName);
        }
    }
    async focus(profileName, targetId) {
        return this.executeTabOperation(profileName, targetId, async (tab) => {
            this.tabRegistry.setActive(targetId, tab.profile);
            await tab.page.bringToFront();
            const title = await tab.page.title();
            return {
                targetId,
                url: tab.page.url(),
                title,
                active: true,
            };
        });
    }
    async close(profileName, targetId) {
        const resolvedName = this.resolveProfileName(profileName);
        const state = this.profileRegistry.get(resolvedName);
        if (!state || state.status !== "running") {
            throw new errors_1.BrowserError("PROFILE_NOT_RUNNING", `Profile ${resolvedName} is not running`);
        }
        const tab = this.tabRegistry.get(targetId, resolvedName);
        if (!tab) {
            return; // Idempotency
        }
        if (tab.activeOperationCount > 0) {
            throw new errors_1.BrowserError("TAB_BUSY", `Tab ${targetId} is busy with active operations`);
        }
        tab.closeRequested = true;
        tab.closing = true;
        try {
            await tab.page.close();
        }
        catch (err) {
            console.error(`Failed to close page for tab ${targetId}:`, err);
        }
        finally {
            this.tabRegistry.remove(targetId, resolvedName);
            ref_store_1.refStore.clear(targetId);
        }
    }
    async navigate(profileName, targetId, url) {
        const config = (0, app_1.loadAgentConfig)();
        const allowedHosts = config.permissions?.browser?.allowedHosts || [];
        const decision = await (0, url_policy_1.evaluateUrl)({ url, allowedHosts });
        if (decision.decision === "deny") {
            throw new errors_1.BrowserError(decision.code, decision.reason);
        }
        return this.executeTabOperation(profileName, targetId, async (tab) => {
            await tab.page.goto(url, { waitUntil: "load", timeout: 30000 });
            const title = await tab.page.title();
            return {
                targetId,
                url: tab.page.url(),
                title,
                active: tab.active,
            };
        });
    }
    async snapshot(profileName, targetId) {
        return this.executeTabOperation(profileName, targetId, async (tab) => {
            return this.snapshotService.generate(tab.page, targetId, tab.profile);
        });
    }
    async act(profileName, targetId, request) {
        return this.executeTabOperation(profileName, targetId, async (tab) => {
            await this.actionExecutor.execute(tab.page, targetId, request);
            const title = await tab.page.title();
            return {
                targetId,
                url: tab.page.url(),
                title,
                active: tab.active,
            };
        });
    }
    async screenshot(profileName, targetId, options) {
        return this.executeTabOperation(profileName, targetId, async (tab) => {
            const buffer = await tab.page.screenshot({ fullPage: options?.fullPage });
            const artifact = new store_1.ArtifactStore().create({
                ownerChatId: options?.chatId || "system",
                sourceTraceId: options?.traceId || "system",
                mimeType: "image/png",
                bytes: buffer,
            });
            return {
                id: artifact.id,
                type: "image",
                mimeType: "image/png",
                path: artifact.local_path,
            };
        });
    }
    async ensureStarted(profileName) {
        const state = this.profileRegistry.get(profileName);
        if (state && state.status === "running" && state.context) {
            return state.context;
        }
        await this.start(profileName);
        const updated = this.profileRegistry.get(profileName);
        if (!updated || !updated.context) {
            throw new errors_1.BrowserError("PROFILE_START_FAILED", `Failed to ensure profile "${profileName}" is started`);
        }
        return updated.context;
    }
    getRegistry() {
        return this.profileRegistry;
    }
    getTabRegistry() {
        return this.tabRegistry;
    }
}
exports.BaseBrowserService = BaseBrowserService;
