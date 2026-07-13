import type { Page, BrowserContext } from "playwright";
import type { BrowserTab } from "./types";

export type TabRecord = {
  targetId: string;
  page: Page;
  context: BrowserContext;
  profile: string;
  createdAt: number;
  lastUsedAt: number;
  active: boolean;
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

    this.records.set(targetId, {
      targetId,
      page,
      context,
      profile,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      active: true,
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
}
