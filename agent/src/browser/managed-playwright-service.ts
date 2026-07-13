import fs from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserService } from "./browser-service";
import type { BrowserTab, BrowserArtifact, BrowserSnapshot, BrowserActionRequest } from "./types";
import { TabRegistry } from "./tab-registry";
import { ProfileManager } from "./profile-manager";
import { ArtifactStore } from "../artifacts/store";
import { SnapshotService } from "./snapshot-service";
import { ActionExecutor } from "./action-executor";

export class ManagedPlaywrightBrowserService implements BrowserService {
  private activeContexts = new Map<string, BrowserContext>();
  private tabRegistry = new TabRegistry();
  private profileManager = new ProfileManager();
  private snapshotService = new SnapshotService();
  private actionExecutor = new ActionExecutor();

  async start(profileName?: string): Promise<{ running: boolean; profile: string }> {
    const profile = this.profileManager.resolve(profileName);
    if (this.activeContexts.has(profile.name)) {
      return { running: true, profile: profile.name };
    }

    fs.mkdirSync(profile.userDataDir, { recursive: true, mode: 0o700 });

    const context = await chromium.launchPersistentContext(profile.userDataDir, {
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

  async stop(profileName?: string): Promise<void> {
    const profile = this.profileManager.resolve(profileName);
    const context = this.activeContexts.get(profile.name);
    if (context) {
      await context.close();
      this.activeContexts.delete(profile.name);
      this.tabRegistry.clear(profile.name);
    }
  }

  async listTabs(profileName?: string): Promise<BrowserTab[]> {
    const profile = this.profileManager.resolve(profileName);
    await this.ensureStarted(profile.name);
    return this.tabRegistry.listWithTitles(profile.name);
  }

  async open(profileName: string | undefined, url: string): Promise<BrowserTab> {
    const profile = this.profileManager.resolve(profileName);
    const context = await this.ensureStarted(profile.name);

    // Reuse the active/blank tab if it exists and is at about:blank
    let page: Page;
    let targetId: string;

    const activeTab = this.tabRegistry.getActive(profile.name);
    if (activeTab && (activeTab.page.url() === "about:blank" || activeTab.page.url() === "")) {
      page = activeTab.page;
      targetId = activeTab.targetId;
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
    } else {
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

  async focus(profileName: string | undefined, targetId: string): Promise<BrowserTab> {
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

  async close(profileName: string | undefined, targetId: string): Promise<void> {
    const profile = this.profileManager.resolve(profileName);
    await this.ensureStarted(profile.name);
    const tab = this.tabRegistry.get(targetId, profile.name);
    if (!tab) {
      throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
    }

    await tab.page.close();
    this.tabRegistry.remove(targetId, profile.name);
  }

  async navigate(profileName: string | undefined, targetId: string, url: string): Promise<BrowserTab> {
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

  async snapshot(profileName: string | undefined, targetId: string): Promise<BrowserSnapshot> {
    const profile = this.profileManager.resolve(profileName);
    await this.ensureStarted(profile.name);
    const tab = this.tabRegistry.get(targetId, profile.name);
    if (!tab) {
      throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
    }

    return this.snapshotService.generate(tab.page, targetId);
  }

  async act(profileName: string | undefined, targetId: string, request: BrowserActionRequest): Promise<BrowserTab> {
    const profile = this.profileManager.resolve(profileName);
    await this.ensureStarted(profile.name);
    const tab = this.tabRegistry.get(targetId, profile.name);
    if (!tab) {
      throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
    }

    await this.actionExecutor.execute(tab.page, targetId, request);

    const title = await tab.page.title();
    return {
      targetId,
      url: tab.page.url(),
      title,
      active: tab.active,
    };
  }

  async screenshot(
    profileName: string | undefined,
    targetId: string,
    options?: { fullPage?: boolean; chatId?: string; traceId?: string }
  ): Promise<BrowserArtifact> {
    const profile = this.profileManager.resolve(profileName);
    await this.ensureStarted(profile.name);
    const tab = this.tabRegistry.get(targetId, profile.name);
    if (!tab) {
      throw new Error(`Tab ${targetId} not found in profile ${profile.name}`);
    }

    const buffer = await tab.page.screenshot({ fullPage: options?.fullPage });
    const artifact = new ArtifactStore().create({
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

  async shutdown(): Promise<void> {
    for (const [profileName, context] of this.activeContexts.entries()) {
      try {
        await context.close();
      } catch (err) {
        console.error(`Failed to close browser context for profile ${profileName}:`, err);
      }
    }
    this.activeContexts.clear();
  }

  private async ensureStarted(profileName: string): Promise<BrowserContext> {
    let context = this.activeContexts.get(profileName);
    if (!context) {
      await this.start(profileName);
      context = this.activeContexts.get(profileName)!;
    }
    return context;
  }
}
