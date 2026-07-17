import crypto from "node:crypto";

/**
 * Linux-local adaptation of OpenClaw's computer-tool contract.
 *
 * Upstream reference: src/tools/openclaw/src/agents/tools/computer-tool.ts
 * This owns model-facing action validation and frame authority. The X11
 * adapter owns screenshot capture and input delivery; no Gateway/node/macOS
 * dependency crosses this boundary.
 */
export const COMPUTER_FRAME_TTL_MS = 60_000;
export const COMPUTER_CONTROL_LEASE_TTL_MS = 2 * 60_000;
export const COMPUTER_CONTROL_LEASE_MAX_ACTIONS = 20;
export const COMPUTER_TOOL_ACTIONS = ["screenshot", "launch", "left_click", "type", "key"] as const;

export type ComputerInput =
  | { action: "left_click"; frameId: string; x: number; y: number }
  | { action: "type"; text: string }
  | { action: "key"; key: string };

export type ComputerLaunch = { action: "launch"; app: string; displayId?: string };

type Frame = { chatId: string; displayId: string; expiresAt: number };

/** Binds coordinate/input authority to a recent observation for one chat. */
export class ComputerFrameStore {
  private readonly frames = new Map<string, Frame>();

  issue(chatId: string, displayId: string, now = Date.now()): { frameId: string; expiresAt: string } {
    this.prune(now);
    const frameId = crypto.randomBytes(16).toString("hex");
    const expiresAt = now + COMPUTER_FRAME_TTL_MS;
    this.frames.set(frameId, { chatId, displayId, expiresAt });
    return { frameId, expiresAt: new Date(expiresAt).toISOString() };
  }

  assertCurrent(frameId: string, chatId: string, now = Date.now()): Frame {
    this.prune(now);
    const frame = this.frames.get(frameId);
    if (!frame || frame.chatId !== chatId) {
      throw new Error("Computer coordinate action requires the most recent screenshot frame for this chat.");
    }
    return frame;
  }

  invalidate(frameId: string): void {
    this.frames.delete(frameId);
  }

  private prune(now: number): void {
    for (const [frameId, frame] of this.frames) {
      if (frame.expiresAt <= now) this.frames.delete(frameId);
    }
  }
}

/**
 * Local equivalent of OpenClaw's per-tool computer state. A controller belongs
 * to one local desktop runtime: effects are serialized in model order and an
 * attempted input invalidates the pixels that authorized it before delivery.
 */
export class ComputerController {
  readonly frames = new ComputerFrameStore();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly targets = new Map<string, { displayId: string }>();
  private readonly leases = new Map<string, { expiresAt: number; actionsRemaining: number }>();

  observe(chatId: string, displayId: string): { frameId: string; expiresAt: string } {
    return this.frames.issue(chatId, displayId);
  }

  /** A target exists only after a configured app has been launched and focused. */
  bindTarget(chatId: string, displayId: string): void {
    this.targets.set(chatId, { displayId });
  }

  currentDisplay(chatId: string): string {
    const target = this.targets.get(chatId);
    if (!target) throw new Error("Computer action requires a focused target; take a screenshot or launch an app first.");
    return target.displayId;
  }

  hasLease(chatId: string, now = Date.now()): boolean {
    const lease = this.leases.get(chatId);
    if (!lease || lease.expiresAt <= now || lease.actionsRemaining <= 0) {
      this.leases.delete(chatId);
      return false;
    }
    return true;
  }

  grantLease(chatId: string, now = Date.now()): { expiresAt: string; actionsRemaining: number } {
    const lease = { expiresAt: now + COMPUTER_CONTROL_LEASE_TTL_MS, actionsRemaining: COMPUTER_CONTROL_LEASE_MAX_ACTIONS };
    this.leases.set(chatId, lease);
    return { expiresAt: new Date(lease.expiresAt).toISOString(), actionsRemaining: lease.actionsRemaining };
  }

  consumeLease(chatId: string, now = Date.now()): boolean {
    if (!this.hasLease(chatId, now)) return false;
    const lease = this.leases.get(chatId)!;
    lease.actionsRemaining -= 1;
    if (lease.actionsRemaining <= 0) this.leases.delete(chatId);
    return true;
  }

  async runInput<T>(input: ComputerInput, chatId: string, execute: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      // A screenshot grants coordinate authority, not application authority.
      // Every input also needs a target established by a verified launch.
      this.currentDisplay(chatId);
      if (input.action === "left_click") {
        this.frames.assertCurrent(input.frameId, chatId);
        // The desktop may change even when delivery fails or times out. Never
        // let a second coordinate action reuse the pre-action observation.
        this.frames.invalidate(input.frameId);
      }
      return await execute();
    });
    this.queue = run.then(() => undefined, () => undefined);
    return await run;
  }
}

/** Returns fixed argv for X11 input; callers must use spawn without a shell. */
export function xdotoolArgs(input: ComputerInput): string[] {
  switch (input.action) {
    case "left_click":
      if (!Number.isInteger(input.x) || !Number.isInteger(input.y) || input.x < 0 || input.y < 0) {
        throw new Error("Computer click coordinates must be non-negative integers.");
      }
      return ["mousemove", "--sync", String(input.x), String(input.y), "click", "1"];
    case "type":
      if (!input.text || input.text.length > 10_000) throw new Error("Computer text must be 1 to 10000 characters.");
      return ["type", "--clearmodifiers", "--", input.text];
    case "key":
      if (!/^[A-Za-z0-9+_-]{1,128}$/.test(input.key)) throw new Error("Computer key is invalid.");
      return ["key", "--clearmodifiers", input.key];
  }
}
