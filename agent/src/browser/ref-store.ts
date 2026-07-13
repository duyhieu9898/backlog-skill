import crypto from "node:crypto";

export type LocatorDescriptor = {
  role?: string;
  name?: string;
  text?: string;
  placeholder?: string;
  nth?: number;
};

export type SnapshotRecord = {
  snapshotId: string;
  targetId: string;
  createdAt: number;
  refs: Map<string, LocatorDescriptor>;
};

export class RefStore {
  private sessions = new Map<string, SnapshotRecord>();
  private latestSnapshots = new Map<string, string>(); // targetId -> snapshotId

  createSnapshot(targetId: string): string {
    const snapshotId = `snap_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const record: SnapshotRecord = {
      snapshotId,
      targetId,
      createdAt: Date.now(),
      refs: new Map(),
    };
    this.sessions.set(snapshotId, record);
    this.latestSnapshots.set(targetId, snapshotId);
    return snapshotId;
  }

  saveRef(snapshotId: string, refId: string, locator: LocatorDescriptor): void {
    const session = this.sessions.get(snapshotId);
    if (!session) {
      throw new Error(`Snapshot session ${snapshotId} not found`);
    }
    session.refs.set(refId, locator);
  }

  getRef(snapshotId: string, refId: string): LocatorDescriptor | undefined {
    const session = this.sessions.get(snapshotId);
    return session?.refs.get(refId);
  }

  getRecord(snapshotId: string): SnapshotRecord | undefined {
    return this.sessions.get(snapshotId);
  }

  getLatestSnapshotId(targetId: string): string | undefined {
    return this.latestSnapshots.get(targetId);
  }

  getLatestSnapshot(targetId: string): SnapshotRecord | undefined {
    const snapshotId = this.getLatestSnapshotId(targetId);
    return snapshotId ? this.sessions.get(snapshotId) : undefined;
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
  }
}

export const refStore = new RefStore();
