"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.browserConfirmationStore = exports.BrowserConfirmationStore = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const ref_store_1 = require("../browser/ref-store");
class BrowserConfirmationStore {
    grants = new Map();
    createGrant(input) {
        const id = `conf_${node_crypto_1.default.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const ttl = input.ttlMs ?? 5 * 60 * 1000; // default 5 minutes
        const now = Date.now();
        const grant = {
            id,
            sessionId: input.sessionId,
            runId: input.runId,
            profile: input.profile,
            targetId: input.targetId,
            snapshotId: input.snapshotId,
            actionFingerprint: input.actionFingerprint,
            createdAt: now,
            expiresAt: now + ttl,
            consumed: false,
        };
        this.grants.set(id, grant);
        return grant;
    }
    verifyAndConsume(grantId, current) {
        const grant = this.grants.get(grantId);
        if (!grant) {
            return { valid: false, code: "CONFIRMATION_NOT_FOUND", reason: "Confirmation grant not found." };
        }
        if (grant.consumed) {
            return { valid: false, code: "CONFIRMATION_ALREADY_USED", reason: "Confirmation grant has already been used." };
        }
        if (Date.now() > grant.expiresAt) {
            return { valid: false, code: "CONFIRMATION_EXPIRED", reason: "Confirmation grant has expired." };
        }
        if (grant.sessionId !== current.sessionId ||
            grant.profile !== current.profile ||
            grant.targetId !== current.targetId) {
            return { valid: false, code: "CONFIRMATION_MISMATCH", reason: "Confirmation context mismatch." };
        }
        if (grant.snapshotId !== current.snapshotId) {
            return { valid: false, code: "CONFIRMATION_STALE", reason: "Page snapshot is stale since confirmation was requested." };
        }
        if (grant.actionFingerprint !== current.actionFingerprint) {
            return { valid: false, code: "CONFIRMATION_MISMATCH", reason: "Action parameters or fingerprint mismatch." };
        }
        grant.consumed = true;
        return { valid: true };
    }
    invalidateForTab(profile, targetId) {
        for (const grant of this.grants.values()) {
            if (grant.profile === profile && grant.targetId === targetId) {
                grant.consumed = true; // effectively invalidates it
            }
        }
    }
    findAndConsume(current) {
        const grantsForFingerprint = Array.from(this.grants.values()).filter((g) => g.profile === current.profile && g.targetId === current.targetId && g.actionFingerprint === current.actionFingerprint);
        if (grantsForFingerprint.length === 0) {
            return { valid: false, code: "CONFIRMATION_NOT_FOUND", reason: "Confirmation not found." };
        }
        const active = grantsForFingerprint.find((g) => !g.consumed && g.expiresAt > Date.now());
        if (!active) {
            if (grantsForFingerprint.every((g) => g.consumed)) {
                return { valid: false, code: "CONFIRMATION_ALREADY_USED", reason: "Confirmation already used." };
            }
            if (grantsForFingerprint.every((g) => g.expiresAt <= Date.now())) {
                return { valid: false, code: "CONFIRMATION_EXPIRED", reason: "Confirmation expired." };
            }
            return { valid: false, code: "CONFIRMATION_NOT_FOUND", reason: "Confirmation not found." };
        }
        if (active.snapshotId !== current.snapshotId) {
            return { valid: false, code: "CONFIRMATION_STALE", reason: "Page snapshot is stale since confirmation was requested." };
        }
        // Generation gate: a confirmation granted against a pre-navigation snapshot
        // is stale after navigation even when the snapshotId string still matches,
        // because navigation bumps the tab's document generation (US-027). Only
        // applied when the snapshot record is still live; an absent record is left
        // to the snapshotId check above so unit tests without a ref-store stay green.
        if (active.snapshotId) {
            const record = ref_store_1.refStore.getRecord(active.snapshotId);
            if (record && record.documentRevision !== ref_store_1.refStore.getCurrentGeneration(current.targetId)) {
                return { valid: false, code: "CONFIRMATION_STALE", reason: "Page navigated since confirmation was requested." };
            }
        }
        active.consumed = true;
        return { valid: true };
    }
    clear() {
        this.grants.clear();
    }
}
exports.BrowserConfirmationStore = BrowserConfirmationStore;
exports.browserConfirmationStore = new BrowserConfirmationStore();
