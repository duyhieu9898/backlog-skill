"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManagedPlaywrightBrowserService = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const playwright_1 = require("playwright");
const tab_registry_1 = require("./tab-registry");
const profile_manager_1 = require("./profile-manager");
const store_1 = require("../artifacts/store");
class ManagedPlaywrightBrowserService {
    activeContexts = new Map();
    tabRegistry = new tab_registry_1.TabRegistry();
    profileManager = new profile_manager_1.ProfileManager();
    async start(profileName) {
        const profile = this.profileManager.resolve(profileName);
        if (this.activeContexts.has(profile.name)) {
            return { running: true, profile: profile.name };
        }
        node_fs_1.default.mkdirSync(profile.userDataDir, { recursive: true, mode: 0o700 });
        const context = await playwright_1.chromium.launchPersistentContext(profile.userDataDir, {
            headless: profile.headless,
            viewport: { width: 1280, height: 800 },
        });
        this.activeContexts.set(profile.name, context);
        // Register any existing pages
        const pages = context.pages();
        for (const page of pages) {
            this.tabRegistry.register(page, context, profile.name);
        }
        return { running: true, profile: profile.name };
    }
    async stop(profileName) {
        const profile = this.profileManager.resolve(profileName);
        const context = this.activeContexts.get(profile.name);
        if (context) {
            await context.close();
            this.activeContexts.delete(profile.name);
            this.tabRegistry.clear(profile.name);
        }
    }
    async listTabs(profileName) {
        const profile = this.profileManager.resolve(profileName);
        await this.ensureStarted(profile.name);
        return this.tabRegistry.listWithTitles(profile.name);
    }
    async open(profileName, url) {
        const profile = this.profileManager.resolve(profileName);
        const context = await this.ensureStarted(profile.name);
        // Reuse the active/blank tab if it exists and is at about:blank
        let page;
        let targetId;
        const activeTab = this.tabRegistry.getActive(profile.name);
        if (activeTab && (activeTab.page.url() === "about:blank" || activeTab.page.url() === "")) {
            page = activeTab.page;
            targetId = activeTab.targetId;
            await page.goto(url, { waitUntil: "load", timeout: 30000 });
        }
        else {
            page = await context.newPage();
            await page.goto(url, { waitUntil: "load", timeout: 30000 });
            targetId = this.tabRegistry.register(page, context, profile.name);
        }
        const title = await page.title();
        return {
            targetId,
            url: page.url(),
            title,
            active: true,
        };
    }
    async focus(profileName, targetId) {
        const profile = this.profileManager.resolve(profileName);
        await this.ensureStarted(profile.name);
        const tab = this.tabRegistry.get(targetId, profile.name);
        if (!tab) {
            throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
        }
        this.tabRegistry.setActive(targetId, profile.name);
        await tab.page.bringToFront();
        const title = await tab.page.title();
        return {
            targetId,
            url: tab.page.url(),
            title,
            active: true,
        };
    }
    async close(profileName, targetId) {
        const profile = this.profileManager.resolve(profileName);
        await this.ensureStarted(profile.name);
        const tab = this.tabRegistry.get(targetId, profile.name);
        if (!tab) {
            throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
        }
        await tab.page.close();
        this.tabRegistry.remove(targetId, profile.name);
    }
    async navigate(profileName, targetId, url) {
        const profile = this.profileManager.resolve(profileName);
        await this.ensureStarted(profile.name);
        const tab = this.tabRegistry.get(targetId, profile.name);
        if (!tab) {
            throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
        }
        await tab.page.goto(url, { waitUntil: "load", timeout: 30000 });
        const title = await tab.page.title();
        return {
            targetId,
            url: tab.page.url(),
            title,
            active: tab.active,
        };
    }
    async screenshot(profileName, targetId, options) {
        const profile = this.profileManager.resolve(profileName);
        await this.ensureStarted(profile.name);
        const tab = this.tabRegistry.get(targetId, profile.name);
        if (!tab) {
            throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
        }
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
    }
    async shutdown() {
        for (const [profileName, context] of this.activeContexts.entries()) {
            try {
                await context.close();
            }
            catch (err) {
                console.error(`Failed to close browser context for profile ${profileName}:`, err);
            }
        }
        this.activeContexts.clear();
    }
    async ensureStarted(profileName) {
        let context = this.activeContexts.get(profileName);
        if (!context) {
            await this.start(profileName);
            context = this.activeContexts.get(profileName);
        }
        return context;
    }
}
exports.ManagedPlaywrightBrowserService = ManagedPlaywrightBrowserService;
