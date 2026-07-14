import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { BrowserService, ShutdownOptions, BrowserShutdownResult } from "./browser-service";
import type { BrowserTab, BrowserArtifact, BrowserSnapshot, BrowserActionRequest } from "./types";
import { TabRegistry } from "./tab-registry";
import { ArtifactStore } from "../artifacts/store";
import { SnapshotService } from "./snapshot-service";
import { ActionExecutor } from "./action-executor";
import { evaluateUrl } from "./url-policy";
import { loadAgentConfig } from "../config/app";
import { BrowserError } from "./errors";
import { resolveBrowserProfile } from "./profile-path";
import { ProfileRegistry, type BrowserProfileState } from "./profile-registry";
import { refStore } from "./ref-store";

export function findChromiumPid(userDataDir: string): number | undefined {
  try {
    if (process.platform === "win32") {
      const output = execSync('wmic process where "CommandLine like \'%' + userDataDir.replace(/\\/g, '\\\\') + '%\'" get ProcessId').toString();
      const lines = output.split("\r\n");
      for (const line of lines) {
        const pid = parseInt(line.trim(), 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    } else {
      const output = execSync("ps -ef").toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.includes(userDataDir) && (line.includes("chrome") || line.includes("Chromium"))) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1], 10);
          if (!isNaN(pid) && pid > 0) return pid;
        }
      }
    }
  } catch (e) {
    // Ignore error
  }
  return undefined;
}

export function checkProfileLock(profileName: string, userDataDir: string): void {
  // 1. Linux/macOS SingletonLock
  const lockPath = path.join(userDataDir, "SingletonLock");
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(lockPath);
      const parts = target.split("-");
      const pidStr = parts[parts.length - 1];
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          throw new BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use by process ${pid}`);
        } catch (err: any) {
          if (err.code === "EPERM") {
            throw new BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use by process ${pid}`);
          }
          // Process is dead: let Chromium handle recovery
        }
      }
    }
  } catch (e) {
    if (e instanceof BrowserError) throw e;
  }

  // 2. Windows lockfile
  const winLockPath = path.join(userDataDir, "lockfile");
  if (fs.existsSync(winLockPath)) {
    try {
      const fd = fs.openSync(winLockPath, "r+");
      fs.closeSync(fd);
    } catch (err: any) {
      if (err.code === "EBUSY" || err.code === "EPERM") {
        throw new BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use (locked file)`);
      }
    }
  }
}

export class ManagedPlaywrightBrowserService implements BrowserService {
  private profileRegistry = new ProfileRegistry();
  private tabRegistry = new TabRegistry();
  private snapshotService = new SnapshotService();
  private actionExecutor = new ActionExecutor();
  private shutdownStarted = false;
  private shutdownPromise?: Promise<BrowserShutdownResult>;
  public sweeper?: any;

  private resolveProfileName(profileName?: string): string {
    if (profileName) return profileName;
    const config = loadAgentConfig();
    return (config.browser as any)?.defaultProfile || "agent";
  }

  async start(profileName?: string): Promise<{ running: boolean; profile: string }> {
    if (this.shutdownStarted) {
      throw new BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
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

      const config = loadAgentConfig();
      const profile = resolveBrowserProfile(resolvedName, config.browser || {});

      checkProfileLock(profile.name, profile.userDataDir);

      const state: BrowserProfileState = {
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
      const headless = (browserConfig as any).headless !== false;

      const context = await chromium.launchPersistentContext(profile.userDataDir, {
        headless,
        viewport: { width: 1280, height: 800 },
      });

      // Register navigation guard
      await context.route("**/*", async (route, request) => {
        if (request.isNavigationRequest()) {
          const currentConfig = loadAgentConfig();
          const allowedHosts = currentConfig.permissions?.browser?.allowedHosts || [];
          const decision = await evaluateUrl({ url: request.url(), allowedHosts });
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
    } catch (err: any) {
      const state = this.profileRegistry.get(resolvedName);
      if (state) {
        state.status = "failed";
      }
      throw err;
    } finally {
      release();
    }
  }

  async startProfile(profileName: string): Promise<void> {
    await this.start(profileName);
  }

  async stop(profileName?: string, options?: ShutdownOptions): Promise<void> {
    const resolvedName = this.resolveProfileName(profileName);
    const release = await this.profileRegistry.getLock(resolvedName).acquire();

    try {
      const state = this.profileRegistry.get(resolvedName);
      if (!state) return;

      state.status = "stopping";
      if (state.context) {
        try {
          await state.context.close();
        } catch (err: any) {
          console.error(`Failed to close browser context for profile ${resolvedName}:`, err);
        }
      }

      // Check process termination
      if (state.browserProcess?.pid) {
        const pid = state.browserProcess.pid;
        const config = loadAgentConfig();
        const forceKillTimeout = options?.forceKillTimeoutMs ?? config.browser?.shutdown?.forceKillTimeoutMs ?? 5000;
        
        let exited = false;
        const end = Date.now() + forceKillTimeout;
        while (Date.now() < end) {
          try {
            process.kill(pid, 0);
            await new Promise(r => setTimeout(r, 100));
          } catch (e: any) {
            if (e.code === "ESRCH") {
              exited = true;
              break;
            }
          }
        }

        if (!exited) {
          try {
            process.kill(pid, "SIGTERM");
          } catch (e) {}
          await new Promise(r => setTimeout(r, 500));
          try {
            process.kill(pid, 0);
            process.kill(pid, "SIGKILL");
          } catch (e) {}
        }
      }

      if (!state.persistent) {
        try {
          fs.rmSync(state.userDataDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`Failed to delete ephemeral directory ${state.userDataDir}:`, err);
        }
      }

      state.status = "stopped";
      this.tabRegistry.clear(resolvedName);
      refStore.clearProfile(resolvedName);
      this.profileRegistry.remove(resolvedName);
    } finally {
      release();
    }
  }

  async shutdownProfile(profileName: string, options?: ShutdownOptions): Promise<void> {
    await this.stop(profileName, options);
  }

  isShuttingDown(): boolean {
    return this.shutdownStarted;
  }

  async shutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.performShutdown(options);
    return this.shutdownPromise;
  }

  private async performShutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult> {
    const startedAt = Date.now();
    this.shutdownStarted = true;

    if (this.sweeper) {
      this.sweeper.stop();
    }

    const config = loadAgentConfig();
    const gracefulTimeout = options?.gracefulTimeoutMs ?? config.browser?.shutdown?.gracefulTimeoutMs ?? 10000;
    const forceKillTimeout = options?.forceKillTimeoutMs ?? config.browser?.shutdown?.forceKillTimeoutMs ?? 5000;

    const closedProfiles: string[] = [];
    const forcedProfiles: string[] = [];
    const errors: Array<{ profileName: string; code: string; message: string }> = [];

    const activeProfiles = this.profileRegistry.list();

    // 1. Wait for active operations to complete
    const graceEnd = Date.now() + gracefulTimeout;
    while (Date.now() < graceEnd) {
      const busy = activeProfiles.some(p => p.activeOperationCount > 0);
      if (!busy) break;
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
          } catch (err: any) {
            errors.push({ profileName: p.name, code: "PROFILE_CLOSE_FAILED", message: err.message });
          }
        }

        if (!p.persistent && p.userDataDir) {
          try {
            fs.rmSync(p.userDataDir, { recursive: true, force: true });
          } catch (e) {}
        }

        if (p.browserProcess?.pid) {
          const pid = p.browserProcess.pid;
          let exited = false;
          const end = Date.now() + forceKillTimeout;
          while (Date.now() < end) {
            try {
              process.kill(pid, 0);
              await new Promise(r => setTimeout(r, 100));
            } catch (err: any) {
              if (err.code === "ESRCH") {
                exited = true;
                break;
              }
            }
          }

          if (!exited) {
            try {
              process.kill(pid, "SIGTERM");
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500));
            try {
              process.kill(pid, 0);
              process.kill(pid, "SIGKILL");
              forcedProfiles.push(p.name);
            } catch (err: any) {
              if (err.code === "ESRCH") {
                closedProfiles.push(p.name);
              } else {
                errors.push({ profileName: p.name, code: "BROWSER_FORCE_KILL_FAILED", message: `Failed to SIGKILL process ${pid}` });
              }
            }
          }
        }

        p.status = "stopped";
        this.tabRegistry.clear(p.name);
        refStore.clearProfile(p.name);
        this.profileRegistry.remove(p.name);
      } finally {
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

  private async enforceTabQuota(profileName: string): Promise<void> {
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

  private async executeTabOperation<T>(
    profileName: string | undefined,
    targetId: string,
    operation: (tab: any) => Promise<T>
  ): Promise<T> {
    if (this.shutdownStarted) {
      throw new BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
    }

    const resolvedName = this.resolveProfileName(profileName);
    const context = await this.ensureStarted(resolvedName);

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

  private async ensureStarted(profileName: string): Promise<BrowserContext> {
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
