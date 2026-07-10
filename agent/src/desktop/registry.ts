import type { DesktopAppDefinition } from "./contracts";

const APP_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

export class DesktopRegistry {
  private readonly appsById: Map<string, DesktopAppDefinition>;

  constructor(apps: DesktopAppDefinition[] = []) {
    this.appsById = new Map();
    for (const app of apps) {
      if (!APP_ID_PATTERN.test(app.id)) throw new Error(`Invalid desktop app ID: ${app.id}`);
      if (!app.label.trim()) throw new Error(`Desktop app ${app.id} is missing a label.`);
      if (this.appsById.has(app.id)) throw new Error(`Duplicate desktop app ID: ${app.id}`);
      this.appsById.set(app.id, { ...app });
    }
  }

  get(appId: string): DesktopAppDefinition | undefined {
    return this.appsById.get(appId);
  }

  list(): DesktopAppDefinition[] {
    return [...this.appsById.values()].sort((left, right) => left.id.localeCompare(right.id));
  }
}
