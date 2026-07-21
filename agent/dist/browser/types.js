"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateBrowserActionRequest = validateBrowserActionRequest;
/** Runtime validation for the provider-facing browser action envelope. */
function validateBrowserActionRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Browser action must be an object.");
    const action = value;
    if (typeof action.kind !== "string")
        throw new Error("Browser action kind is required.");
    const requireText = (key) => {
        if (typeof action[key] !== "string" || !action[key])
            throw new Error(`Browser ${action.kind} requires ${key}.`);
    };
    if (["click", "fill", "type", "select"].includes(action.kind)) {
        requireText("ref");
        requireText("snapshotId");
        if (action.kind === "fill" || action.kind === "select")
            requireText("value");
        if (action.kind === "type")
            requireText("text");
    }
    else if (action.kind === "press") {
        requireText("key");
    }
    else if (action.kind === "scroll") {
        if (action.direction !== "up" && action.direction !== "down")
            throw new Error("Browser scroll requires direction up or down.");
    }
    else if (action.kind === "wait") {
        if (action.milliseconds !== undefined && (!Number.isInteger(action.milliseconds) || action.milliseconds < 0))
            throw new Error("Browser wait milliseconds must be a non-negative integer.");
    }
    else {
        throw new Error(`Unsupported browser action: ${action.kind}`);
    }
    // Reject cross-variant fields: a ref action must not carry `key`, a press
    // must not carry `ref`/`snapshotId`, etc. This keeps provider-validation and
    // runtime-validation in lockstep (US-027 AC).
    const allowedPerKind = {
        click: ["ref", "snapshotId"],
        fill: ["ref", "value", "snapshotId"],
        type: ["ref", "text", "snapshotId"],
        select: ["ref", "value", "snapshotId"],
        press: ["key"],
        scroll: ["direction", "amount"],
        wait: ["milliseconds"],
    };
    const allowed = allowedPerKind[action.kind];
    if (allowed) {
        for (const key of Object.keys(action)) {
            if (key !== "kind" && !allowed.includes(key)) {
                throw new Error(`Browser ${action.kind} does not accept "${key}".`);
            }
        }
    }
    return action;
}
