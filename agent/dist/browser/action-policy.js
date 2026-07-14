"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeActionFingerprint = computeActionFingerprint;
exports.evaluateAction = evaluateAction;
const node_crypto_1 = __importDefault(require("node:crypto"));
const DESTRUCTIVE_TERMS = /\b(delete|remove|cancel|erase|revoke|uninstall|disable|xóa|hủy)\b/i;
const CONSEQUENTIAL_TERMS = /\b(pay|purchase|submit|send|publish|confirm|save|invite|transfer|place|mua|thanh toán|gửi|đăng|xác nhận|lưu)\b/i;
const HARMLESS_TERMS = /\b(filter|search|find|query|view|read|show|info|help|documentation|doc|preview)\b/i;
const INTERACTIVE_ROLES = new Set([
    "button",
    "menuitem",
    "checkbox",
    "radio",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "tab",
    "switch",
]);
function computeActionFingerprint(context) {
    const kind = context.action.kind;
    const targetId = context.targetId;
    const snapshotId = context.snapshotId || "";
    const ref = context.element?.ref || "";
    const role = (context.element?.role || "").toLowerCase();
    const name = (context.element?.name || "").toLowerCase();
    let origin = "";
    try {
        origin = new URL(context.url).origin;
    }
    catch { }
    // Redact secrets from the payload for fingerprinting
    let payloadStr = "";
    if (context.action.kind === "fill") {
        const isSensitive = context.element?.inputType === "password" ||
            /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(context.element?.name || "") ||
            /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(context.element?.placeholder || "");
        payloadStr = isSensitive ? "[REDACTED]" : context.action.value;
    }
    else if (context.action.kind === "type") {
        const isSensitive = context.element?.inputType === "password" ||
            /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(context.element?.name || "") ||
            /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(context.element?.placeholder || "");
        payloadStr = isSensitive ? "[REDACTED]" : context.action.text;
    }
    else {
        payloadStr = JSON.stringify(context.action);
    }
    const raw = [kind, targetId, snapshotId, ref, role, name, origin, payloadStr].join("|");
    return node_crypto_1.default.createHash("sha256").update(raw).digest("hex");
}
function evaluateAction(context, config) {
    const action = context.action;
    // 1. Check if input is sensitive
    let isSensitive = false;
    if (context.element) {
        const name = (context.element.name || "").toLowerCase();
        const placeholder = (context.element.placeholder || "").toLowerCase();
        if (context.element.inputType === "password" ||
            /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(name) ||
            /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(placeholder)) {
            isSensitive = true;
        }
    }
    let risk = isSensitive ? "sensitive-input" : "none";
    // 2. Classify risk based on action kind and element details
    if (action.kind === "click" || action.kind === "fill" || action.kind === "type" || action.kind === "select") {
        if (context.element && !isSensitive) {
            const role = (context.element.role || "").toLowerCase();
            // Links are treated as navigation, allowed by default
            if (role !== "link") {
                const isInteractive = INTERACTIVE_ROLES.has(role) || !role; // if no role, treat as potentially interactive
                if (isInteractive) {
                    const textToMatch = [
                        context.element.name,
                        context.element.text,
                        context.element.label,
                        context.element.placeholder,
                    ]
                        .filter(Boolean)
                        .join(" ");
                    const isHarmless = HARMLESS_TERMS.test(textToMatch);
                    if (!isHarmless) {
                        if (DESTRUCTIVE_TERMS.test(textToMatch)) {
                            risk = "destructive";
                        }
                        else if (CONSEQUENTIAL_TERMS.test(textToMatch)) {
                            risk = "external-side-effect";
                        }
                    }
                }
            }
        }
    }
    else if (action.kind === "press") {
        const key = action.key.toLowerCase();
        if (key === "enter" || key === " " || key === "spacebar") {
            if (context.element) {
                const role = (context.element.role || "").toLowerCase();
                const textToMatch = [
                    context.element.name,
                    context.element.text,
                    context.element.label,
                    context.element.placeholder,
                ]
                    .filter(Boolean)
                    .join(" ");
                const isHarmless = HARMLESS_TERMS.test(textToMatch);
                if (!isHarmless && role !== "link") {
                    // Pressing Enter in search box: allow
                    const isSearch = role === "searchbox" ||
                        /\b(search|find|query)\b/i.test(textToMatch) ||
                        context.element.inputType === "search";
                    if (!isSearch) {
                        // If destructive button is focused
                        if (DESTRUCTIVE_TERMS.test(textToMatch)) {
                            risk = "destructive";
                        }
                        else if (CONSEQUENTIAL_TERMS.test(textToMatch) ||
                            role === "textarea" ||
                            /\b(message|chat|composer|comment|reply|post|send)\b/i.test(textToMatch)) {
                            risk = "external-side-effect";
                        }
                    }
                }
            }
        }
    }
    // 3. Evaluate decisions according to configuration
    if (risk === "destructive") {
        const mode = config.destructiveActions || "confirm";
        if (mode === "deny") {
            return {
                decision: "deny",
                code: "ACTION_DENIED",
                reason: "Destructive browser action is denied by policy.",
            };
        }
        if (mode === "confirm") {
            return {
                decision: "confirm",
                code: "CONFIRMATION_REQUIRED",
                reason: "Explicit authorization is required for destructive action.",
                actionFingerprint: computeActionFingerprint(context),
            };
        }
    }
    if (risk === "external-side-effect") {
        const mode = config.consequentialActions || "confirm";
        if (mode === "deny") {
            return {
                decision: "deny",
                code: "ACTION_DENIED",
                reason: "Consequential browser action is denied by policy.",
            };
        }
        if (mode === "confirm") {
            return {
                decision: "confirm",
                code: "CONFIRMATION_REQUIRED",
                reason: "Explicit authorization is required for consequential action.",
                actionFingerprint: computeActionFingerprint(context),
            };
        }
    }
    // For sensitive-input and none, we allow
    return { decision: "allow" };
}
