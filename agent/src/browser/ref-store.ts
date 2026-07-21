import crypto from "node:crypto";
import { loadAgentConfig } from "../config/app";

export type LocatorDescriptor = {
  role?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  nth?: number;
};

export type SnapshotRecord = {
  snapshotId: string;
  profileName: string;
  targetId: string;
  /**
   * Monotonic per-tab document generation stamped at snapshot time. Navigation
   * bumps the tab's generation; a snapshot whose revision no longer matches
   * the current generation is stale even if it is still the "latest" id — this
   * is what prevents a ref from silently rebinding onto a new document when
   * the model navigates without re-snapshotting (US-027 silent-rebind fix).
   */
  documentRevision: number;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  refs: Map<string, LocatorDescriptor>;
  url?: string;
};

export class RefStore {
  private sessions = new Map<string, SnapshotRecord>();
  private latestSnapshots = new Map<string, string>(); // targetId -> snapshotId
  private tabGenerations = new Map<string, number>(); // targetId -> generation

  /** Current document generation for a tab. Bumped on navigation. */
  getCurrentGeneration(targetId: string): number {
    return this.tabGenerations.get(targetId) ?? 0;
  }

  /**
   * Bump the tab's document generation and drop it from the latest mapping.
   * Called after a successful navigation so any outstanding snapshot — even
   * the latest one — is treated as stale until a fresh snapshot is captured.
   */
  bumpGeneration(targetId: string): void {
    this.tabGenerations.set(targetId, this.getCurrentGeneration(targetId) + 1);
    this.latestSnapshots.delete(targetId);
  }

  createSnapshot(targetId: string, profileName: string, url?: string): string {
    const snapshotId = `snap_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const config = loadAgentConfig();
    const ttlMinutes = config.browser?.cleanup?.snapshotTtlMinutes ?? 10;
    const expiresAt = Date.now() + ttlMinutes * 60 * 1000;

    const record: SnapshotRecord = {
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

  saveRef(snapshotId: string, refId: string, locator: LocatorDescriptor): void {
    const session = this.getRecord(snapshotId);
    if (!session) {
      throw new Error(`Snapshot session ${snapshotId} not found`);
    }
    session.refs.set(refId, locator);
  }

  getRef(snapshotId: string, refId: string): LocatorDescriptor | undefined {
    const session = this.getRecord(snapshotId);
    return session?.refs.get(refId);
  }

  getRecord(snapshotId: string): SnapshotRecord | undefined {
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

  getLatestSnapshotId(targetId: string): string | undefined {
    const snapshotId = this.latestSnapshots.get(targetId);
    if (!snapshotId) return undefined;

    // Check if it's expired
    const record = this.getRecord(snapshotId);
    if (!record) return undefined;

    // A latest snapshot whose document revision no longer matches the tab's
    // current generation (navigation happened after it was captured) is not
    // actionable — treat it as absent so callers capture a fresh one.
    if (record.documentRevision !== this.getCurrentGeneration(targetId)) return undefined;

    return snapshotId;
  }

  getLatestSnapshot(targetId: string): SnapshotRecord | undefined {
    const snapshotId = this.getLatestSnapshotId(targetId);
    return snapshotId ? this.getRecord(snapshotId) : undefined;
  }

  clear(targetId: string): void {
    const idsToRemove: string[] = [];
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

  clearProfile(profileName: string): void {
    const idsToRemove: string[] = [];
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

  pruneExpired(): string[] {
    const now = Date.now();
    const prunedIds: string[] = [];
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

export const refStore = new RefStore();
