import type { BrowserTab, BrowserArtifact } from "./types";
import { ManagedPlaywrightBrowserService } from "./managed-playwright-service";

export interface BrowserService {
  start(profile?: string): Promise<{ running: boolean; profile: string }>;
  stop(profile?: string): Promise<void>;
  listTabs(profile?: string): Promise<BrowserTab[]>;
  open(profile: string | undefined, url: string): Promise<BrowserTab>;
  focus(profile: string | undefined, targetId: string): Promise<BrowserTab>;
  close(profile: string | undefined, targetId: string): Promise<void>;
  navigate(profile: string | undefined, targetId: string, url: string): Promise<BrowserTab>;
  screenshot(
    profile: string | undefined,
    targetId: string,
    options?: { fullPage?: boolean; chatId?: string; traceId?: string }
  ): Promise<BrowserArtifact>;
  shutdown(): Promise<void>;
}

export const browserService: BrowserService = new ManagedPlaywrightBrowserService();
