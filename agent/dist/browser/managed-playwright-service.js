"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManagedPlaywrightBrowserService = void 0;
exports.findChromiumPid = findChromiumPid;
exports.checkProfileLock = checkProfileLock;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_child_process_1 = require("node:child_process");
const playwright_1 = require("playwright");
const tab_registry_1 = require("./tab-registry");
const store_1 = require("../artifacts/store");
const snapshot_service_1 = require("./snapshot-service");
const action_executor_1 = require("./action-executor");
const url_policy_1 = require("./url-policy");
const app_1 = require("../config/app");
const errors_1 = require("./errors");
const profile_path_1 = require("./profile-path");
const profile_registry_1 = require("./profile-registry");
const ref_store_1 = require("./ref-store");
function findChromiumPid(userDataDir) {
    try {
        if (process.platform === "win32") {
            const output = (0, node_child_process_1.execSync)('wmic process where "CommandLine like \'%' + userDataDir.replace(/\\/g, '\\\\') + '%\'" get ProcessId').toString();
            const lines = output.split("\r\n");
            for (const line of lines) {
                const pid = parseInt(line.trim(), 10);
                if (!isNaN(pid) && pid > 0)
                    return pid;
            }
        }
        else {
            const output = (0, node_child_process_1.execSync)("ps -ef").toString();
            const lines = output.split("\n");
            for (const line of lines) {
                if (line.includes(userDataDir) && (line.includes("chrome") || line.includes("Chromium"))) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parseInt(parts[1], 10);
                    if (!isNaN(pid) && pid > 0)
                        return pid;
                }
            }
        }
    }
    catch (e) {
        // Ignore error
    }
    return undefined;
}
function checkProfileLock(profileName, userDataDir) {
    // 1. Linux/macOS SingletonLock
    const lockPath = node_path_1.default.join(userDataDir, "SingletonLock");
    try {
        const stat = node_fs_1.default.lstatSync(lockPath);
        if (stat.isSymbolicLink()) {
            const target = node_fs_1.default.readlinkSync(lockPath);
            const parts = target.split("-");
            const pidStr = parts[parts.length - 1];
            const pid = parseInt(pidStr, 10);
            if (!isNaN(pid)) {
                try {
                    process.kill(pid, 0);
                    throw new errors_1.BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use by process ${pid}`);
                }
                catch (err) {
                    if (err.code === "EPERM") {
                        throw new errors_1.BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use by process ${pid}`);
                    }
                    // Process is dead: let Chromium handle recovery
                }
            }
        }
    }
    catch (e) {
        if (e instanceof errors_1.BrowserError)
            throw e;
    }
    // 2. Windows lockfile
    const winLockPath = node_path_1.default.join(userDataDir, "lockfile");
    if (node_fs_1.default.existsSync(winLockPath)) {
        try {
            const fd = node_fs_1.default.openSync(winLockPath, "r+");
            node_fs_1.default.closeSync(fd);
        }
        catch (err) {
            if (err.code === "EBUSY" || err.code === "EPERM") {
                throw new errors_1.BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use (locked file)`);
            }
        }
    }
}
class ManagedPlaywrightBrowserService {
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
    async start(profileName) {
        if (this.shutdownStarted) {
            throw new errors_1.BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
        }
        const resolvedName = this.resolveProfileName(profileName);
        const release = await this.profileRegistry.getLock(resolvedName).acquire();
        try {
            const existing = this.profileRegistry.get(resolvedName);
            if (existing) {
                if (existing.status === "running") {
                    return { running: true, profile: resolvedName };
                }
                if (existing.status === "starting") {
                    return { running: true, profile: resolvedName };
                }
            }
            const config = (0, app_1.loadAgentConfig)();
            const profile = (0, profile_path_1.resolveBrowserProfile)(resolvedName, config.browser || {});
            checkProfileLock(profile.name, profile.userDataDir);
            const state = {
                name: profile.name,
                persistent: profile.persistent,
                userDataDir: profile.userDataDir,
                status: "starting",
                activeOperationCount: 0,
                shutdownRequested: false,
                lastUsedAt: Date.now(),
            };
            this.profileRegistry.register(resolvedName, state);
            const browserConfig = config.browser || {};
            const headless = browserConfig.headless !== false;
            const context = await playwright_1.chromium.launchPersistentContext(profile.userDataDir, {
                headless,
                viewport: { width: 1280, height: 800 },
            });
            // Register navigation guard
            await context.route("**/*", async (route, request) => {
                if (request.isNavigationRequest()) {
                    const currentConfig = (0, app_1.loadAgentConfig)();
                    const allowedHosts = currentConfig.permissions?.browser?.allowedHosts || [];
                    const decision = await (0, url_policy_1.evaluateUrl)({ url: request.url(), allowedHosts });
                    if (decision.decision === "deny") {
                        await route.abort("blockedbyclient");
                        return;
                    }
                }
                await route.continue();
            });
            state.context = context;
            state.status = "running";
            state.startedAt = Date.now();
            state.lastUsedAt = Date.now();
            // Find PID
            const pid = findChromiumPid(profile.userDataDir);
            if (pid) {
                state.browserProcess = { pid };
            }
            // Register any existing pages
            const pages = context.pages();
            for (const page of pages) {
                this.tabRegistry.register(page, context, resolvedName);
            }
            return { running: true, profile: resolvedName };
        }
        catch (err) {
            const state = this.profileRegistry.get(resolvedName);
            if (state) {
                state.status = "failed";
            }
            throw err;
        }
        finally {
            release();
        }
    }
    async startProfile(profileName) {
        await this.start(profileName);
    }
    async stop(profileName, options) {
        const resolvedName = this.resolveProfileName(profileName);
        const release = await this.profileRegistry.getLock(resolvedName).acquire();
        try {
            const state = this.profileRegistry.get(resolvedName);
            if (!state)
                return;
            state.status = "stopping";
            if (state.context) {
                try {
                    await state.context.close();
                }
                catch (err) {
                    console.error(`Failed to close browser context for profile ${resolvedName}:`, err);
                }
            }
            // Check process termination
            if (state.browserProcess?.pid) {
                const pid = state.browserProcess.pid;
                const config = (0, app_1.loadAgentConfig)();
                const forceKillTimeout = options?.forceKillTimeoutMs ?? config.browser?.shutdown?.forceKillTimeoutMs ?? 5000;
                let exited = false;
                const end = Date.now() + forceKillTimeout;
                while (Date.now() < end) {
                    try {
                        process.kill(pid, 0);
                        await new Promise(r => setTimeout(r, 100));
                    }
                    catch (e) {
                        if (e.code === "ESRCH") {
                            exited = true;
                            break;
                        }
                    }
                }
                if (!exited) {
                    try {
                        process.kill(pid, "SIGTERM");
                    }
                    catch (e) { }
                    await new Promise(r => setTimeout(r, 500));
                    try {
                        process.kill(pid, 0);
                        process.kill(pid, "SIGKILL");
                    }
                    catch (e) { }
                }
            }
            if (!state.persistent) {
                try {
                    node_fs_1.default.rmSync(state.userDataDir, { recursive: true, force: true });
                }
                catch (err) {
                    console.error(`Failed to delete ephemeral directory ${state.userDataDir}:`, err);
                }
            }
            state.status = "stopped";
            this.tabRegistry.clear(resolvedName);
            ref_store_1.refStore.clearProfile(resolvedName);
            this.profileRegistry.remove(resolvedName);
        }
        finally {
            release();
        }
    }
    async shutdownProfile(profileName, options) {
        await this.stop(profileName, options);
    }
    isShuttingDown() {
        return this.shutdownStarted;
    }
    async shutdown(options) {
        if (this.shutdownPromise) {
            return this.shutdownPromise;
        }
        this.shutdownPromise = this.performShutdown(options);
        return this.shutdownPromise;
    }
    async performShutdown(options) {
        const startedAt = Date.now();
        this.shutdownStarted = true;
        if (this.sweeper) {
            this.sweeper.stop();
        }
        const config = (0, app_1.loadAgentConfig)();
        const gracefulTimeout = options?.gracefulTimeoutMs ?? config.browser?.shutdown?.gracefulTimeoutMs ?? 10000;
        const forceKillTimeout = options?.forceKillTimeoutMs ?? config.browser?.shutdown?.forceKillTimeoutMs ?? 5000;
        const closedProfiles = [];
        const forcedProfiles = [];
        const errors = [];
        const activeProfiles = this.profileRegistry.list();
        // 1. Wait for active operations to complete
        const graceEnd = Date.now() + gracefulTimeout;
        while (Date.now() < graceEnd) {
            const busy = activeProfiles.some(p => p.activeOperationCount > 0);
            if (!busy)
                break;
            await new Promise(r => setTimeout(r, 100));
        }
        // 2. Stop and kill
        for (const p of activeProfiles) {
            const release = await this.profileRegistry.getLock(p.name).acquire();
            try {
                p.status = "stopping";
                p.shutdownRequested = true;
                if (p.context) {
                    try {
                        await p.context.close();
                        closedProfiles.push(p.name);
                    }
                    catch (err) {
                        errors.push({ profileName: p.name, code: "PROFILE_CLOSE_FAILED", message: err.message });
                    }
                }
                if (!p.persistent && p.userDataDir) {
                    try {
                        node_fs_1.default.rmSync(p.userDataDir, { recursive: true, force: true });
                    }
                    catch (e) { }
                }
                if (p.browserProcess?.pid) {
                    const pid = p.browserProcess.pid;
                    let exited = false;
                    const end = Date.now() + forceKillTimeout;
                    while (Date.now() < end) {
                        try {
                            process.kill(pid, 0);
                            await new Promise(r => setTimeout(r, 100));
                        }
                        catch (err) {
                            if (err.code === "ESRCH") {
                                exited = true;
                                break;
                            }
                        }
                    }
                    if (!exited) {
                        try {
                            process.kill(pid, "SIGTERM");
                        }
                        catch (e) { }
                        await new Promise(r => setTimeout(r, 500));
                        try {
                            process.kill(pid, 0);
                            process.kill(pid, "SIGKILL");
                            forcedProfiles.push(p.name);
                        }
                        catch (err) {
                            if (err.code === "ESRCH") {
                                closedProfiles.push(p.name);
                            }
                            else {
                                errors.push({ profileName: p.name, code: "BROWSER_FORCE_KILL_FAILED", message: `Failed to SIGKILL process ${pid}` });
                            }
                        }
                    }
                }
                p.status = "stopped";
                this.tabRegistry.clear(p.name);
                ref_store_1.refStore.clearProfile(p.name);
                this.profileRegistry.remove(p.name);
            }
            finally {
                release();
            }
        }
        return {
            startedAt,
            completedAt: Date.now(),
            closedProfiles,
            forcedProfiles,
            errors,
        };
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
        const context = await this.ensureStarted(resolvedName);
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
exports.ManagedPlaywrightBrowserService = ManagedPlaywrightBrowserService;
