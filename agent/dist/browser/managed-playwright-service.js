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
const base_browser_service_1 = require("./base-browser-service");
const app_1 = require("../config/app");
const errors_1 = require("./errors");
const profile_path_1 = require("./profile-path");
const ref_store_1 = require("./ref-store");
const url_policy_1 = require("./url-policy");
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
class ManagedPlaywrightBrowserService extends base_browser_service_1.BaseBrowserService {
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
}
exports.ManagedPlaywrightBrowserService = ManagedPlaywrightBrowserService;
