import type { BrowserTab, BrowserArtifact, BrowserSnapshot, BrowserActionRequest } from "./types";
import { ManagedPlaywrightBrowserService } from "./managed-playwright-service";

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
  stop(profile?: string): Promise<void>;
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

export const browserService: BrowserService = new ManagedPlaywrightBrowserService();
