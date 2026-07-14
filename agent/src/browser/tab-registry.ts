import type { Page, BrowserContext } from "playwright";
import type { BrowserTab } from "./types";
import { browserConfirmationStore } from "../security/browser-confirmation";

export type TabRecord = {
  targetId: string;
  page: Page;
  context: BrowserContext;
  profile: string;
  createdAt: number;
  lastUsedAt: number;
  lastFocusedAt?: number;
  active: boolean; // representing isActiveTab

  activeOperationCount: number;
  protectedUntil?: number;
  closeRequested: boolean;
  closing: boolean;
};

export class TabRegistry {
  private records = new Map<string, TabRecord>();
  private counter = 0;

  register(page: Page, context: BrowserContext, profile: string): string {
    this.counter += 1;
    const targetId = `tab_${String(this.counter).padStart(2, "0")}`;

    // Deactivate others for this profile
    for (const record of this.records.values()) {
      if (record.profile === profile) {
        record.active = false;
      }
    }

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        browserConfirmationStore.invalidateForTab(profile, targetId);
      }
    });

    this.records.set(targetId, {
      targetId,
      page,
      context,
      profile,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      active: true,
      activeOperationCount: 0,
      closeRequested: false,
      closing: false,
    });

    return targetId;
  }

  get(targetId: string, profile: string): TabRecord | undefined {
    const record = this.records.get(targetId);
    if (record && record.profile === profile) {
      record.lastUsedAt = Date.now();
      return record;
    }
    return undefined;
  }

  getAllRecords(): TabRecord[] {
    return Array.from(this.records.values());
  }

  list(profile: string): BrowserTab[] {
    return Array.from(this.records.values())
      .filter((record) => record.profile === profile)
      .map((record) => ({
        targetId: record.targetId,
        url: record.page.url(),
        title: "Page",
        active: record.active,
      }));
  }

  async listWithTitles(profile: string): Promise<BrowserTab[]> {
    const tabs = Array.from(this.records.values()).filter((record) => record.profile === profile);
    const result: BrowserTab[] = [];
    for (const record of tabs) {
      let title = "";
      try {
        title = await record.page.title();
      } catch {
        title = "Unavailable";
      }
      result.push({
        targetId: record.targetId,
        url: record.page.url(),
        title,
        active: record.active,
      });
    }
    return result;
  }

  setActive(targetId: string, profile: string): void {
    const targetRecord = this.records.get(targetId);
    if (!targetRecord || targetRecord.profile !== profile) {
      throw new Error(`Tab ${targetId} not found in profile ${profile}`);
    }

    for (const record of this.records.values()) {
      if (record.profile === profile) {
        record.active = (record.targetId === targetId);
        if (record.active) {
          record.lastFocusedAt = Date.now();
          record.lastUsedAt = Date.now();
        }
      }
    }
  }

  getActive(profile: string): TabRecord | undefined {
    return Array.from(this.records.values()).find(
      (record) => record.profile === profile && record.active
    );
  }

  remove(targetId: string, profile: string): void {
    const record = this.records.get(targetId);
    if (record && record.profile === profile) {
      this.records.delete(targetId);
      if (record.active) {
        const remaining = Array.from(this.records.values())
          .filter((r) => r.profile === profile)
          .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
        if (remaining.length > 0) {
          remaining[0].active = true;
        }
      }
    }
  }

  clear(profile: string): void {
    for (const [id, record] of this.records.entries()) {
      if (record.profile === profile) {
        this.records.delete(id);
      }
    }
  }

  acquireLease(targetId: string, profile: string): { release(): void } {
    const record = this.get(targetId, profile);
    if (!record) {
      throw new Error(`Tab ${targetId} not found in profile ${profile}`);
    }
    record.activeOperationCount++;
    record.lastUsedAt = Date.now();
    let released = false;
    return {
      release: () => {
        if (!released) {
          record.activeOperationCount = Math.max(0, record.activeOperationCount - 1);
          record.lastUsedAt = Date.now();
          released = true;
        }
      }
    };
  }
}
