"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TabRegistry = void 0;
const browser_confirmation_1 = require("../security/browser-confirmation");
class TabRegistry {
    records = new Map();
    counter = 0;
    register(page, context, profile) {
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
                browser_confirmation_1.browserConfirmationStore.invalidateForTab(profile, targetId);
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
    get(targetId, profile) {
        const record = this.records.get(targetId);
        if (record && record.profile === profile) {
            record.lastUsedAt = Date.now();
            return record;
        }
        return undefined;
    }
    getAllRecords() {
        return Array.from(this.records.values());
    }
    list(profile) {
        return Array.from(this.records.values())
            .filter((record) => record.profile === profile)
            .map((record) => ({
            targetId: record.targetId,
            url: record.page.url(),
            title: "Page",
            active: record.active,
        }));
    }
    async listWithTitles(profile) {
        const tabs = Array.from(this.records.values()).filter((record) => record.profile === profile);
        const result = [];
        for (const record of tabs) {
            let title = "";
            try {
                title = await record.page.title();
            }
            catch {
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
    setActive(targetId, profile) {
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
    getActive(profile) {
        return Array.from(this.records.values()).find((record) => record.profile === profile && record.active);
    }
    remove(targetId, profile) {
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
    clear(profile) {
        for (const [id, record] of this.records.entries()) {
            if (record.profile === profile) {
                this.records.delete(id);
            }
        }
    }
    acquireLease(targetId, profile) {
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
exports.TabRegistry = TabRegistry;
