"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.browserService = exports.DispatchingBrowserService = void 0;
const managed_playwright_service_1 = require("./managed-playwright-service");
const cdp_browser_service_1 = require("./cdp-browser-service");
const app_1 = require("../config/app");
class DispatchingBrowserService {
    managedService = new managed_playwright_service_1.ManagedPlaywrightBrowserService();
    cdpService = new cdp_browser_service_1.CdpBrowserService();
    getService(profileName) {
        const config = (0, app_1.loadAgentConfig)();
        const resolvedName = profileName || config.browser?.defaultProfile || "agent";
        const profileConfig = config.browser?.profiles?.[resolvedName];
        if (profileConfig?.mode === "cdp") {
            return this.cdpService;
        }
        return this.managedService;
    }
    // Registry access for tests/sweeper
    getRegistry(profileName) {
        return this.getService(profileName).getRegistry();
    }
    getTabRegistry(profileName) {
        return this.getService(profileName).getTabRegistry();
    }
    async start(profile) {
        return this.getService(profile).start(profile);
    }
    async stop(profile, options) {
        return this.getService(profile).stop(profile, options);
    }
    async listTabs(profile) {
        return this.getService(profile).listTabs(profile);
    }
    async open(profile, url) {
        return this.getService(profile).open(profile, url);
    }
    async focus(profile, targetId) {
        return this.getService(profile).focus(profile, targetId);
    }
    async close(profile, targetId) {
        return this.getService(profile).close(profile, targetId);
    }
    async navigate(profile, targetId, url) {
        return this.getService(profile).navigate(profile, targetId, url);
    }
    async snapshot(profile, targetId) {
        return this.getService(profile).snapshot(profile, targetId);
    }
    async act(profile, targetId, request) {
        return this.getService(profile).act(profile, targetId, request);
    }
    async screenshot(profile, targetId, options) {
        return this.getService(profile).screenshot(profile, targetId, options);
    }
    async shutdown(options) {
        const managedResult = await this.managedService.shutdown(options);
        const cdpResult = await this.cdpService.shutdown(options);
        return {
            startedAt: Math.min(managedResult.startedAt, cdpResult.startedAt),
            completedAt: Math.max(managedResult.completedAt, cdpResult.completedAt),
            closedProfiles: [...managedResult.closedProfiles, ...cdpResult.closedProfiles],
            forcedProfiles: [...managedResult.forcedProfiles, ...cdpResult.forcedProfiles],
            errors: [...managedResult.errors, ...cdpResult.errors],
        };
    }
    async startProfile(profileName) {
        await this.getService(profileName).startProfile(profileName);
    }
    async shutdownProfile(profileName, options) {
        await this.getService(profileName).shutdownProfile(profileName, options);
    }
    isShuttingDown() {
        return this.managedService.isShuttingDown() || this.cdpService.isShuttingDown();
    }
}
exports.DispatchingBrowserService = DispatchingBrowserService;
exports.browserService = new DispatchingBrowserService();
