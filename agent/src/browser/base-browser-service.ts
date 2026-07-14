import type { BrowserContext } from "playwright";
import type { BrowserService, ShutdownOptions, BrowserShutdownResult } from "./browser-service";
import type { BrowserTab, BrowserArtifact, BrowserSnapshot, BrowserActionRequest } from "./types";
import { TabRegistry } from "./tab-registry";
import { ArtifactStore } from "../artifacts/store";
import { SnapshotService } from "./snapshot-service";
import { ActionExecutor } from "./action-executor";
import { evaluateUrl } from "./url-policy";
import { loadAgentConfig } from "../config/app";
import { BrowserError } from "./errors";
import { ProfileRegistry } from "./profile-registry";
import { refStore } from "./ref-store";

export abstract class BaseBrowserService implements BrowserService {
  protected profileRegistry = new ProfileRegistry();
  protected tabRegistry = new TabRegistry();
  protected snapshotService = new SnapshotService();
  protected actionExecutor = new ActionExecutor();
  protected shutdownStarted = false;
  protected shutdownPromise?: Promise<BrowserShutdownResult>;
  public sweeper?: any;

  protected resolveProfileName(profileName?: string): string {
    if (profileName) return profileName;
    const config = loadAgentConfig();
    return (config.browser as any)?.defaultProfile || "agent";
  }

  abstract start(profileName?: string): Promise<{ running: boolean; profile: string }>;
  abstract stop(profileName?: string, options?: ShutdownOptions): Promise<void>;
  abstract shutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult>;

  async startProfile(profileName: string): Promise<void> {
    await this.start(profileName);
  }

  async shutdownProfile(profileName: string, options?: ShutdownOptions): Promise<void> {
    await this.stop(profileName, options);
  }

  isShuttingDown(): boolean {
    return this.shutdownStarted;
  }

  protected async enforceTabQuota(profileName: string): Promise<void> {
    const config = loadAgentConfig();
    const maxTabs = config.browser?.cleanup?.maxTabsPerProfile ?? 10;

    const tabs = this.tabRegistry.getAllRecords().filter(t => t.profile === profileName);
    if (tabs.length < maxTabs) {
      return;
    }

    const eligible = tabs.filter(t => t.activeOperationCount === 0 && !t.closing);
    if (eligible.length === 0) {
      throw new BrowserError("TAB_LIMIT_REACHED", `Cannot open new tab: quota of ${maxTabs} reached and no tabs can be reclaimed`);
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

  async listTabs(profileName?: string): Promise<BrowserTab[]> {
    const resolvedName = this.resolveProfileName(profileName);
    await this.ensureStarted(resolvedName);
    return this.tabRegistry.listWithTitles(resolvedName);
  }

  async open(profileName: string | undefined, url: string): Promise<BrowserTab> {
    const config = loadAgentConfig();
    const allowedHosts = config.permissions?.browser?.allowedHosts || [];
    const decision = await evaluateUrl({ url, allowedHosts });
    if (decision.decision === "deny") {
      throw new BrowserError(decision.code as any, decision.reason);
    }

    if (this.shutdownStarted) {
      throw new BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
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
      } finally {
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
    } finally {
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

  protected async executeTabOperation<T>(
    profileName: string | undefined,
    targetId: string,
    operation: (tab: any) => Promise<T>
  ): Promise<T> {
    if (this.shutdownStarted) {
      throw new BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
    }

    const resolvedName = this.resolveProfileName(profileName);
    await this.ensureStarted(resolvedName);

    const tab = this.tabRegistry.get(targetId, resolvedName);
    if (!tab) {
      throw new BrowserError("TAB_NOT_FOUND", `Tab ${targetId} not found in profile ${resolvedName}`);
    }

    if (tab.closing) {
      throw new BrowserError("TAB_BUSY", `Tab ${targetId} is closing`);
    }

    this.profileRegistry.markOperationStarted(resolvedName);
    const lease = this.tabRegistry.acquireLease(targetId, resolvedName);
    try {
      return await operation(tab);
    } finally {
      lease.release();
      this.profileRegistry.markOperationFinished(resolvedName);
    }
  }

  async focus(profileName: string | undefined, targetId: string): Promise<BrowserTab> {
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

  async close(profileName: string | undefined, targetId: string): Promise<void> {
    const resolvedName = this.resolveProfileName(profileName);
    const state = this.profileRegistry.get(resolvedName);
    if (!state || state.status !== "running") {
      throw new BrowserError("PROFILE_NOT_RUNNING", `Profile ${resolvedName} is not running`);
    }

    const tab = this.tabRegistry.get(targetId, resolvedName);
    if (!tab) {
      return; // Idempotency
    }

    if (tab.activeOperationCount > 0) {
      throw new BrowserError("TAB_BUSY", `Tab ${targetId} is busy with active operations`);
    }

    tab.closeRequested = true;
    tab.closing = true;

    try {
      await tab.page.close();
    } catch (err: any) {
      console.error(`Failed to close page for tab ${targetId}:`, err);
    } finally {
      this.tabRegistry.remove(targetId, resolvedName);
      refStore.clear(targetId);
    }
  }

  async navigate(profileName: string | undefined, targetId: string, url: string): Promise<BrowserTab> {
    const config = loadAgentConfig();
    const allowedHosts = config.permissions?.browser?.allowedHosts || [];
    const decision = await evaluateUrl({ url, allowedHosts });
    if (decision.decision === "deny") {
      throw new BrowserError(decision.code as any, decision.reason);
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

  async snapshot(profileName: string | undefined, targetId: string): Promise<BrowserSnapshot> {
    return this.executeTabOperation(profileName, targetId, async (tab) => {
      return this.snapshotService.generate(tab.page, targetId, tab.profile);
    });
  }

  async act(profileName: string | undefined, targetId: string, request: BrowserActionRequest): Promise<BrowserTab> {
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

  async screenshot(
    profileName: string | undefined,
    targetId: string,
    options?: { fullPage?: boolean; chatId?: string; traceId?: string }
  ): Promise<BrowserArtifact> {
    return this.executeTabOperation(profileName, targetId, async (tab) => {
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
    });
  }

  protected async ensureStarted(profileName: string): Promise<BrowserContext> {
    const state = this.profileRegistry.get(profileName);
    if (state && state.status === "running" && state.context) {
      return state.context;
    }
    await this.start(profileName);
    const updated = this.profileRegistry.get(profileName);
    if (!updated || !updated.context) {
      throw new BrowserError("PROFILE_START_FAILED", `Failed to ensure profile "${profileName}" is started`);
    }
    return updated.context;
  }

  public getRegistry(): ProfileRegistry {
    return this.profileRegistry;
  }

  public getTabRegistry(): TabRegistry {
    return this.tabRegistry;
  }
}
