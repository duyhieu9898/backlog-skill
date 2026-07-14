import type { BrowserContext } from "playwright";

export type BrowserProfileState = {
  name: string;
  persistent: boolean;
  userDataDir: string;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  context?: BrowserContext;
  browserProcess?: { pid: number };
  startedAt?: number;
  lastUsedAt: number;
  activeOperationCount: number;
  shutdownRequested: boolean;
};

export class ProfileLock {
  private promise: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const currentPromise = this.promise;
    this.promise = nextPromise;
    await currentPromise;
    return release!;
  }
}

export class ProfileRegistry {
  private states = new Map<string, BrowserProfileState>();
  private locks = new Map<string, ProfileLock>();

  get(profileName: string): BrowserProfileState | undefined {
    return this.states.get(profileName);
  }

  getLock(profileName: string): ProfileLock {
    let lock = this.locks.get(profileName);
    if (!lock) {
      lock = new ProfileLock();
      this.locks.set(profileName, lock);
    }
    return lock;
  }

  register(profileName: string, state: BrowserProfileState): void {
    this.states.set(profileName, state);
  }

  list(): BrowserProfileState[] {
    return Array.from(this.states.values());
  }

  markOperationStarted(profileName: string): void {
    const state = this.states.get(profileName);
    if (state) {
      state.activeOperationCount++;
      state.lastUsedAt = Date.now();
    }
  }

  markOperationFinished(profileName: string): void {
    const state = this.states.get(profileName);
    if (state) {
      state.activeOperationCount = Math.max(0, state.activeOperationCount - 1);
      state.lastUsedAt = Date.now();
    }
  }

  remove(profileName: string): void {
    this.states.delete(profileName);
  }
}
