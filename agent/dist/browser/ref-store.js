"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.refStore = exports.RefStore = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
class RefStore {
    sessions = new Map();
    latestSnapshots = new Map(); // targetId -> snapshotId
    createSnapshot(targetId, url) {
        const snapshotId = `snap_${node_crypto_1.default.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const record = {
            snapshotId,
            targetId,
            createdAt: Date.now(),
            refs: new Map(),
            url,
        };
        this.sessions.set(snapshotId, record);
        this.latestSnapshots.set(targetId, snapshotId);
        return snapshotId;
    }
    saveRef(snapshotId, refId, locator) {
        const session = this.sessions.get(snapshotId);
        if (!session) {
            throw new Error(`Snapshot session ${snapshotId} not found`);
        }
        session.refs.set(refId, locator);
    }
    getRef(snapshotId, refId) {
        const session = this.sessions.get(snapshotId);
        return session?.refs.get(refId);
    }
    getRecord(snapshotId) {
        return this.sessions.get(snapshotId);
    }
    getLatestSnapshotId(targetId) {
        return this.latestSnapshots.get(targetId);
    }
    getLatestSnapshot(targetId) {
        const snapshotId = this.getLatestSnapshotId(targetId);
        return snapshotId ? this.sessions.get(snapshotId) : undefined;
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
    }
}
exports.RefStore = RefStore;
exports.refStore = new RefStore();
