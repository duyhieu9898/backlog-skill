import { chromium, type BrowserContext } from "playwright";
import { BaseBrowserService } from "./base-browser-service";
import type { ShutdownOptions, BrowserShutdownResult } from "./browser-service";
import { loadAgentConfig } from "../config/app";
import { BrowserError } from "./errors";
import { evaluateUrl } from "./url-policy";
import { refStore } from "./ref-store";
import type { BrowserProfileState } from "./profile-registry";

export class CdpBrowserService extends BaseBrowserService {
  async start(profileName?: string): Promise<{ running: boolean; profile: string }> {
    if (this.shutdownStarted) {
      throw new BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
    }

    const resolvedName = this.resolveProfileName(profileName);
    const release = await this.profileRegistry.getLock(resolvedName).acquire();

    try {
      const existing = this.profileRegistry.get(resolvedName);
      if (existing) {
        if (existing.status === "running" || existing.status === "starting") {
          return { running: true, profile: resolvedName };
        }
      }

      const config = loadAgentConfig();
      const profileSpec = config.browser?.profiles?.[resolvedName];
      if (!profileSpec || profileSpec.mode !== "cdp") {
        throw new BrowserError("PROFILE_START_FAILED", `Profile "${resolvedName}" is not configured for CDP mode`);
      }
      const endpoint = profileSpec.endpoint;
      if (!endpoint) {
        throw new BrowserError("PROFILE_START_FAILED", `CDP endpoint is not configured for profile "${resolvedName}"`);
      }

      const state: BrowserProfileState = {
        name: resolvedName,
        persistent: true,
        userDataDir: "",
        status: "starting",
        activeOperationCount: 0,
        shutdownRequested: false,
        lastUsedAt: Date.now(),
      };
      this.profileRegistry.register(resolvedName, state);

      const browser = await chromium.connectOverCDP(endpoint);
      (state as any).cdpBrowser = browser;

      const contexts = browser.contexts();
      const context = contexts[0] || (await browser.newContext());

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

  async stop(profileName?: string, options?: ShutdownOptions): Promise<void> {
    const resolvedName = this.resolveProfileName(profileName);
    const release = await this.profileRegistry.getLock(resolvedName).acquire();

    try {
      const state = this.profileRegistry.get(resolvedName);
      if (!state) return;

      state.status = "stopping";

      // Close all pages registered to this profile to disconnect cleanly
      const tabs = this.tabRegistry.getAllRecords().filter(t => t.profile === resolvedName);
      for (const tab of tabs) {
        try {
          await tab.page.close();
        } catch (e) {}
      }

      // Close context
      if (state.context) {
        try {
          await state.context.close();
        } catch (err: any) {
          console.error(`Failed to close context for CDP profile ${resolvedName}:`, err);
        }
      }

      // Close CDP browser
      const cdpBrowser = (state as any).cdpBrowser;
      if (cdpBrowser) {
        try {
          await cdpBrowser.close();
        } catch (err: any) {
          console.error(`Failed to close CDP connection for profile ${resolvedName}:`, err);
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

    // 2. Stop each active profile
    for (const p of activeProfiles) {
      const release = await this.profileRegistry.getLock(p.name).acquire();
      try {
        p.status = "stopping";
        p.shutdownRequested = true;

        const tabs = this.tabRegistry.getAllRecords().filter(t => t.profile === p.name);
        for (const tab of tabs) {
          try {
            await tab.page.close();
          } catch (e) {}
        }

        if (p.context) {
          try {
            await p.context.close();
          } catch (err: any) {
            errors.push({ profileName: p.name, code: "PROFILE_CLOSE_FAILED", message: err.message });
          }
        }

        const cdpBrowser = (p as any).cdpBrowser;
        if (cdpBrowser) {
          try {
            await cdpBrowser.close();
            closedProfiles.push(p.name);
          } catch (err: any) {
            errors.push({ profileName: p.name, code: "CDP_CLOSE_FAILED", message: err.message });
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
}
