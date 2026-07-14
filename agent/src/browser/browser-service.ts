import type { BrowserTab, BrowserArtifact, BrowserSnapshot, BrowserActionRequest } from "./types";
import { ManagedPlaywrightBrowserService } from "./managed-playwright-service";
import { CdpBrowserService } from "./cdp-browser-service";
import { loadAgentConfig } from "../config/app";

export type ShutdownOptions = {
  gracefulTimeoutMs?: number;
  forceKillTimeoutMs?: number;
};

export type BrowserShutdownResult = {
  startedAt: number;
  completedAt: number;

  closedProfiles: string[];
  forcedProfiles: string[];

  errors: Array<{
    profileName: string;
    code: string;
    message: string;
  }>;
};

export interface BrowserService {
  start(profile?: string): Promise<{ running: boolean; profile: string }>;
  stop(profile?: string, options?: ShutdownOptions): Promise<void>;
  listTabs(profile?: string): Promise<BrowserTab[]>;
  open(profile: string | undefined, url: string): Promise<BrowserTab>;
  focus(profile: string | undefined, targetId: string): Promise<BrowserTab>;
  close(profile: string | undefined, targetId: string): Promise<void>;
  navigate(profile: string | undefined, targetId: string, url: string): Promise<BrowserTab>;
  snapshot(profile: string | undefined, targetId: string): Promise<BrowserSnapshot>;
  act(profile: string | undefined, targetId: string, request: BrowserActionRequest): Promise<BrowserTab>;
  screenshot(
    profile: string | undefined,
    targetId: string,
    options?: { fullPage?: boolean; chatId?: string; traceId?: string }
  ): Promise<BrowserArtifact>;
  shutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult>;

  startProfile(profileName: string): Promise<void>;
  shutdownProfile(profileName: string, options?: ShutdownOptions): Promise<void>;
  isShuttingDown(): boolean;
}

export class DispatchingBrowserService implements BrowserService {
  private managedService = new ManagedPlaywrightBrowserService();
  private cdpService = new CdpBrowserService();

  private getService(profileName?: string): BrowserService {
    const config = loadAgentConfig();
    const resolvedName = profileName || (config.browser as any)?.defaultProfile || "agent";
    const profileConfig = config.browser?.profiles?.[resolvedName];
    if (profileConfig?.mode === "cdp") {
      return this.cdpService;
    }
    return this.managedService;
  }

  // Registry access for tests/sweeper
  getRegistry(profileName?: string) {
    return (this.getService(profileName) as any).getRegistry();
  }

  getTabRegistry(profileName?: string) {
    return (this.getService(profileName) as any).getTabRegistry();
  }

  async start(profile?: string) {
    return this.getService(profile).start(profile);
  }

  async stop(profile?: string, options?: ShutdownOptions) {
    return this.getService(profile).stop(profile, options);
  }

  async listTabs(profile?: string) {
    return this.getService(profile).listTabs(profile);
  }

  async open(profile: string | undefined, url: string) {
    return this.getService(profile).open(profile, url);
  }

  async focus(profile: string | undefined, targetId: string) {
    return this.getService(profile).focus(profile, targetId);
  }

  async close(profile: string | undefined, targetId: string) {
    return this.getService(profile).close(profile, targetId);
  }

  async navigate(profile: string | undefined, targetId: string, url: string) {
    return this.getService(profile).navigate(profile, targetId, url);
  }

  async snapshot(profile: string | undefined, targetId: string) {
    return this.getService(profile).snapshot(profile, targetId);
  }

  async act(profile: string | undefined, targetId: string, request: BrowserActionRequest) {
    return this.getService(profile).act(profile, targetId, request);
  }

  async screenshot(profile: string | undefined, targetId: string, options?: any) {
    return this.getService(profile).screenshot(profile, targetId, options);
  }

  async shutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult> {
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

  async startProfile(profileName: string): Promise<void> {
    await this.getService(profileName).startProfile(profileName);
  }

  async shutdownProfile(profileName: string, options?: ShutdownOptions): Promise<void> {
    await this.getService(profileName).shutdownProfile(profileName, options);
  }

  isShuttingDown(): boolean {
    return this.managedService.isShuttingDown() || this.cdpService.isShuttingDown();
  }
}

export const browserService: BrowserService = new DispatchingBrowserService();
