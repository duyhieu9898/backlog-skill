"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refStore = exports.RefStore = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const app_1 = require("../config/app");
class RefStore {
    sessions = new Map();
    latestSnapshots = new Map(); // targetId -> snapshotId
    tabGenerations = new Map(); // targetId -> generation
    /** Current document generation for a tab. Bumped on navigation. */
    getCurrentGeneration(targetId) {
        return this.tabGenerations.get(targetId) ?? 0;
    }
    /**
     * Bump the tab's document generation and drop it from the latest mapping.
     * Called after a successful navigation so any outstanding snapshot — even
     * the latest one — is treated as stale until a fresh snapshot is captured.
     */
    bumpGeneration(targetId) {
        this.tabGenerations.set(targetId, this.getCurrentGeneration(targetId) + 1);
        this.latestSnapshots.delete(targetId);
    }
    createSnapshot(targetId, profileName, url) {
        const snapshotId = `snap_${node_crypto_1.default.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const config = (0, app_1.loadAgentConfig)();
        const ttlMinutes = config.browser?.cleanup?.snapshotTtlMinutes ?? 10;
        const expiresAt = Date.now() + ttlMinutes * 60 * 1000;
        const record = {
            snapshotId,
            profileName,
            targetId,
            documentRevision: this.getCurrentGeneration(targetId),
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
            expiresAt,
            refs: new Map(),
            url,
        };
        this.sessions.set(snapshotId, record);
        this.latestSnapshots.set(targetId, snapshotId);
        return snapshotId;
    }
    saveRef(snapshotId, refId, locator) {
        const session = this.getRecord(snapshotId);
        if (!session) {
            throw new Error(`Snapshot session ${snapshotId} not found`);
        }
        session.refs.set(refId, locator);
    }
    getRef(snapshotId, refId) {
        const session = this.getRecord(snapshotId);
        return session?.refs.get(refId);
    }
    getRecord(snapshotId) {
        const session = this.sessions.get(snapshotId);
        if (session) {
            if (session.expiresAt <= Date.now()) {
                this.sessions.delete(snapshotId);
                if (this.latestSnapshots.get(session.targetId) === snapshotId) {
                    this.latestSnapshots.delete(session.targetId);
                }
                return undefined;
            }
            session.lastAccessedAt = Date.now();
            return session;
        }
        return undefined;
    }
    getLatestSnapshotId(targetId) {
        const snapshotId = this.latestSnapshots.get(targetId);
        if (!snapshotId)
            return undefined;
        // Check if it's expired
        const record = this.getRecord(snapshotId);
        if (!record)
            return undefined;
        // A latest snapshot whose document revision no longer matches the tab's
        // current generation (navigation happened after it was captured) is not
        // actionable — treat it as absent so callers capture a fresh one.
        if (record.documentRevision !== this.getCurrentGeneration(targetId))
            return undefined;
        return snapshotId;
    }
    getLatestSnapshot(targetId) {
        const snapshotId = this.getLatestSnapshotId(targetId);
        return snapshotId ? this.getRecord(snapshotId) : undefined;
    }
    clear(targetId) {
        const idsToRemove = [];
        for (const [snapshotId, record] of this.sessions.entries()) {
            if (record.targetId === targetId) {
                idsToRemove.push(snapshotId);
            }
        }
        for (const id of idsToRemove) {
            this.sessions.delete(id);
        }
        this.latestSnapshots.delete(targetId);
        this.tabGenerations.delete(targetId);
    }
    clearProfile(profileName) {
        const idsToRemove = [];
        for (const [snapshotId, record] of this.sessions.entries()) {
            if (record.profileName === profileName) {
                idsToRemove.push(snapshotId);
            }
        }
        for (const id of idsToRemove) {
            this.sessions.delete(id);
        }
        for (const [targetId, snapId] of this.latestSnapshots.entries()) {
            if (idsToRemove.includes(snapId)) {
                this.latestSnapshots.delete(targetId);
            }
        }
    }
    pruneExpired() {
        const now = Date.now();
        const prunedIds = [];
        for (const [snapshotId, record] of this.sessions.entries()) {
            if (record.expiresAt <= now) {
                prunedIds.push(snapshotId);
                this.sessions.delete(snapshotId);
                if (this.latestSnapshots.get(record.targetId) === snapshotId) {
                    this.latestSnapshots.delete(record.targetId);
                }
            }
        }
        return prunedIds;
    }
}
exports.RefStore = RefStore;
exports.refStore = new RefStore();
