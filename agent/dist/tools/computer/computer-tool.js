"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ComputerController = exports.ComputerFrameStore = exports.COMPUTER_TOOL_ACTIONS = exports.COMPUTER_CONTROL_LEASE_MAX_ACTIONS = exports.COMPUTER_CONTROL_LEASE_TTL_MS = exports.COMPUTER_FRAME_TTL_MS = void 0;
exports.xdotoolArgs = xdotoolArgs;
const node_crypto_1 = __importDefault(require("node:crypto"));
/**
 * Linux-local adaptation of OpenClaw's computer-tool contract.
 *
 * Upstream source: https://github.com/openclaw/openclaw (computer-tool)
 * This owns model-facing action validation and frame authority. The X11
 * adapter owns screenshot capture and input delivery; no Gateway/node/macOS
 * dependency crosses this boundary.
 */
exports.COMPUTER_FRAME_TTL_MS = 60_000;
exports.COMPUTER_CONTROL_LEASE_TTL_MS = 2 * 60_000;
exports.COMPUTER_CONTROL_LEASE_MAX_ACTIONS = 20;
exports.COMPUTER_TOOL_ACTIONS = ["screenshot", "launch", "left_click", "type", "key"];
/** Binds coordinate/input authority to a recent observation for one chat. */
class ComputerFrameStore {
    frames = new Map();
    issue(chatId, displayId, now = Date.now()) {
        this.prune(now);
        const frameId = node_crypto_1.default.randomBytes(16).toString("hex");
        const expiresAt = now + exports.COMPUTER_FRAME_TTL_MS;
        this.frames.set(frameId, { chatId, displayId, expiresAt });
        return { frameId, expiresAt: new Date(expiresAt).toISOString() };
    }
    assertCurrent(frameId, chatId, now = Date.now()) {
        this.prune(now);
        const frame = this.frames.get(frameId);
        if (!frame || frame.chatId !== chatId) {
            throw new Error("Computer coordinate action requires the most recent screenshot frame for this chat.");
        }
        return frame;
    }
    invalidate(frameId) {
        this.frames.delete(frameId);
    }
    prune(now) {
        for (const [frameId, frame] of this.frames) {
            if (frame.expiresAt <= now)
                this.frames.delete(frameId);
        }
    }
}
exports.ComputerFrameStore = ComputerFrameStore;
/**
 * Local equivalent of OpenClaw's per-tool computer state. A controller belongs
 * to one local desktop runtime: effects are serialized in model order and an
 * attempted input invalidates the pixels that authorized it before delivery.
 */
class ComputerController {
    frames = new ComputerFrameStore();
    queue = Promise.resolve();
    targets = new Map();
    leases = new Map();
    observe(chatId, displayId) {
        return this.frames.issue(chatId, displayId);
    }
    /** A target exists only after a configured app has been launched and focused. */
    bindTarget(chatId, displayId) {
        this.targets.set(chatId, { displayId });
    }
    currentDisplay(chatId) {
        const target = this.targets.get(chatId);
        if (!target)
            throw new Error("Computer action requires a focused target; take a screenshot or launch an app first.");
        return target.displayId;
    }
    hasLease(chatId, now = Date.now()) {
        const lease = this.leases.get(chatId);
        if (!lease || lease.expiresAt <= now || lease.actionsRemaining <= 0) {
            this.leases.delete(chatId);
            return false;
        }
        return true;
    }
    grantLease(chatId, now = Date.now()) {
        const lease = { expiresAt: now + exports.COMPUTER_CONTROL_LEASE_TTL_MS, actionsRemaining: exports.COMPUTER_CONTROL_LEASE_MAX_ACTIONS };
        this.leases.set(chatId, lease);
        return { expiresAt: new Date(lease.expiresAt).toISOString(), actionsRemaining: lease.actionsRemaining };
    }
    consumeLease(chatId, now = Date.now()) {
        if (!this.hasLease(chatId, now))
            return false;
        const lease = this.leases.get(chatId);
        lease.actionsRemaining -= 1;
        if (lease.actionsRemaining <= 0)
            this.leases.delete(chatId);
        return true;
    }
    async runInput(input, chatId, execute) {
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
exports.ComputerController = ComputerController;
/** Returns fixed argv for X11 input; callers must use spawn without a shell. */
function xdotoolArgs(input) {
    switch (input.action) {
        case "left_click":
            if (!Number.isInteger(input.x) || !Number.isInteger(input.y) || input.x < 0 || input.y < 0) {
                throw new Error("Computer click coordinates must be non-negative integers.");
            }
            return ["mousemove", "--sync", String(input.x), String(input.y), "click", "1"];
        case "type":
            if (!input.text || input.text.length > 10_000)
                throw new Error("Computer text must be 1 to 10000 characters.");
            return ["type", "--clearmodifiers", "--", input.text];
        case "key":
            if (!/^[A-Za-z0-9+_-]{1,128}$/.test(input.key))
                throw new Error("Computer key is invalid.");
            return ["key", "--clearmodifiers", input.key];
    }
}
