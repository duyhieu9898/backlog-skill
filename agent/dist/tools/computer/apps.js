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
    /**
     * Resolves only a configured app. Model input never becomes a launcher argv:
     * the returned appId always came from the local allowlist.
     */
    resolve(query) {
        const normalized = query.trim().toLocaleLowerCase();
        if (!normalized)
            return undefined;
        const exact = this.list().filter((app) => [app.id, app.label].some((value) => value.toLocaleLowerCase() === normalized));
        if (exact.length === 1)
            return exact[0];
        const partial = this.list().filter((app) => [app.id.replace(/\.desktop$/i, ""), app.label].some((value) => value.toLocaleLowerCase().includes(normalized)));
        return partial.length === 1 ? partial[0] : undefined;
    }
    list() {
        return [...this.appsById.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
}
exports.DesktopRegistry = DesktopRegistry;
