"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DesktopRegistry = void 0;
const APP_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
class DesktopRegistry {
    appsById;
    constructor(apps = []) {
        this.appsById = new Map();
        for (const app of apps) {
            if (!APP_ID_PATTERN.test(app.id))
                throw new Error(`Invalid desktop app ID: ${app.id}`);
            if (!app.label.trim())
                throw new Error(`Desktop app ${app.id} is missing a label.`);
            if (this.appsById.has(app.id))
                throw new Error(`Duplicate desktop app ID: ${app.id}`);
            this.appsById.set(app.id, { ...app });
        }
    }
    get(appId) {
        return this.appsById.get(appId);
    }
    list() {
        return [...this.appsById.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
}
exports.DesktopRegistry = DesktopRegistry;
