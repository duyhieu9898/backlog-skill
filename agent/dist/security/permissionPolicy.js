"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionPolicy = void 0;
exports.canonicalizePolicyPath = canonicalizePolicyPath;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const contracts_1 = require("../tools/contracts");
const url_policy_1 = require("../browser/url-policy");
const action_policy_1 = require("../browser/action-policy");
const policy_patterns_1 = require("./policy-patterns");
function nearestExistingPath(candidate) {
    let current = candidate;
    const suffix = [];
    while (!node_fs_1.default.existsSync(current)) {
        const parent = node_path_1.default.dirname(current);
        if (parent === current)
            throw new Error(`No existing parent for ${candidate}`);
        suffix.unshift(node_path_1.default.basename(current));
        current = parent;
    }
    return { existing: current, suffix };
}
function canonicalizePolicyPath(candidate) {
    if (!candidate || candidate.includes("\0"))
        throw new Error("Path is empty or contains NUL.");
    const absolute = node_path_1.default.resolve(candidate);
    const { existing, suffix } = nearestExistingPath(absolute);
    return node_path_1.default.join(node_fs_1.default.realpathSync(existing), ...suffix);
}
/**
 * A clear owner request is approval for the exact task, including the ordinary
 * package/service steps needed to complete it. This is deliberately narrow:
 * it only relaxes the system-impact prompt, never the destructive deny rules.
 */
function hasExplicitSystemIntent(action, userIntent) {
    if (!userIntent || !(0, policy_patterns_1.needsSystemApproval)(action))
        return false;
    const intent = userIntent.toLowerCase();
    const asksForSystemWork = /\b(?:install|uninstall|remove|configure|config|restart|start|stop|enable|disable|upgrade|update)\b|cài(?:\s+đặt)?|gỡ|cấu\s*hình|khởi\s*động|dừng|bật|tắt/.test(intent);
    if (!asksForSystemWork)
        return false;
    // A generic request such as “restart the service” is intentionally enough
    // for the matching service operation. When a concrete package/service name
    // appears, require that it also appears in the command.
    const command = [action.executable || "", ...(action.args || []), action.shellCommand || ""].join(" ").toLowerCase();
    const namedTargets = intent.match(/\b[a-z0-9][a-z0-9._+-]{2,}\b/g) || [];
    const ignored = new Set(["install", "uninstall", "remove", "configure", "config", "restart", "start", "stop", "enable", "disable", "upgrade", "update", "system", "service", "sudo", "please", "with", "this", "that"]);
    const requestedTargets = namedTargets.filter((term) => !ignored.has(term));
    return requestedTargets.length === 0 || requestedTargets.some((term) => command.includes(term));
}
function normalizeAction(action) {
    if (action.kind === "command.run") {
        return { ...action, cwd: canonicalizePolicyPath(action.cwd) };
    }
    if ((0, contracts_1.isDesktopToolAction)(action) || (0, contracts_1.isBrowserToolAction)(action))
        return action;
    return { ...action, path: canonicalizePolicyPath(action.path) };
}
function desktopCapability(action) {
    switch (action.kind) {
        case "desktop.capture":
            return "screen.capture";
        case "desktop.launch":
            return "app.launch";
        case "desktop.observe":
            return "ui.observe";
        case "desktop.act":
            return "ui.act";
    }
}
function denied(action, reasonCode, reason) {
    return { outcome: "deny", reasonCode, reason, action };
}
class PermissionPolicy {
    desktopAppIds;
    browserConfig;
    constructor(config) {
        this.desktopAppIds = new Set(config.desktopAppIds || []);
        this.browserConfig = config.browser || {};
    }
    evaluate(action, context = {}) {
        let normalized;
        try {
            normalized = normalizeAction(action);
        }
        catch (error) {
            return {
                outcome: "deny",
                reasonCode: "INVALID_PATH",
                reason: error instanceof Error ? error.message : String(error),
                action,
            };
        }
        if ((0, contracts_1.isDesktopToolAction)(normalized)) {
            return this.evaluateDesktop(normalized, context);
        }
        if ((0, contracts_1.isBrowserToolAction)(normalized)) {
            return this.evaluateBrowser(normalized, context);
        }
        const target = normalized.kind === "command.run" ? normalized.cwd : normalized.path;
        if (normalized.kind === "command.run" && (0, policy_patterns_1.isClearlyDestructiveCommand)(normalized)) {
            return denied(normalized, "DENIED_PATH", "Command matches a clearly destructive pattern.");
        }
        if ((0, policy_patterns_1.isSecretLike)(target)) {
            if (!context.confirmationGranted)
                return { outcome: "confirm", reasonCode: "CONFIRMATION_REQUIRED", reason: `Sensitive path requires approval: ${target}`, action: normalized };
            return { outcome: "allow", reasonCode: "ALLOWED", reason: "Sensitive path approved for this task.", action: normalized };
        }
        if (normalized.kind === "file.read" ||
            normalized.kind === "file.list" ||
            normalized.kind === "file.exists") {
            return { outcome: "allow", reasonCode: "ALLOWED", reason: "Read path is allowed.", action: normalized };
        }
        const explicitSystemIntent = normalized.kind === "command.run" && hasExplicitSystemIntent(normalized, context.userIntent);
        const needsConfirmation = normalized.kind === "command.run"
            ? (normalized.requiresConfirmation || normalized.externalSideEffect || (0, policy_patterns_1.needsSystemApproval)(normalized)) && !explicitSystemIntent
            : false;
        if (needsConfirmation && !context.confirmationGranted) {
            return {
                outcome: "confirm",
                reasonCode: "CONFIRMATION_REQUIRED",
                reason: `${normalized.kind} requires explicit confirmation.`,
                action: normalized,
            };
        }
        return {
            outcome: "allow",
            reasonCode: "ALLOWED",
            reason: `${normalized.kind} is allowed by policy.`,
            action: normalized,
        };
    }
    evaluateDesktop(action, context) {
        const capability = desktopCapability(action);
        const status = context.desktopStatus?.capabilities.find((entry) => entry.capability === capability);
        if (!status?.available || status.permission.state === "unavailable") {
            return denied(action, "DESKTOP_CAPABILITY_UNAVAILABLE", `${capability} is not available on this runtime.`);
        }
        if (status.permission.state !== "granted") {
            return denied(action, "DESKTOP_PERMISSION_DENIED", `${capability} permission is not granted.`);
        }
        if (action.kind === "desktop.launch" && !this.desktopAppIds.has(action.appId)) {
            return denied(action, "UNDECLARED_DESKTOP_APP", `Desktop app is not declared: ${action.appId}`);
        }
        if ((action.kind === "desktop.capture" || action.kind === "desktop.observe") &&
            action.displayId &&
            !context.desktopStatus?.displays.some((display) => display.id === action.displayId)) {
            return denied(action, "UNKNOWN_DISPLAY", `Desktop display is not available: ${action.displayId}`);
        }
        return {
            outcome: "allow",
            reasonCode: "ALLOWED",
            reason: `${action.kind} is allowed as ordinary local desktop automation.`,
            action,
        };
    }
    evaluateBrowser(action, context) {
        const kind = action.kind;
        if (kind === "browser.open" || kind === "browser.navigate") {
            const url = action.url;
            if (url) {
                const allowedHosts = this.browserConfig.allowedHosts || [];
                const decision = (0, url_policy_1.evaluateUrlSync)({ url, allowedHosts });
                if (decision.decision === "deny") {
                    return {
                        outcome: "deny",
                        reasonCode: decision.code,
                        reason: decision.reason,
                        action,
                    };
                }
            }
        }
        if (kind === "browser.act") {
            if (context.browserContext) {
                const decision = (0, action_policy_1.evaluateAction)(context.browserContext, this.browserConfig);
                if (decision.decision === "deny") {
                    return {
                        outcome: "deny",
                        reasonCode: "ACTION_DENIED",
                        reason: decision.reason,
                        action,
                    };
                }
                if (decision.decision === "confirm") {
                    if (context.confirmationGranted) {
                        return {
                            outcome: "allow",
                            reasonCode: "ALLOWED",
                            reason: "Action confirmed by user.",
                            action,
                        };
                    }
                    return {
                        outcome: "confirm",
                        reasonCode: "CONFIRMATION_REQUIRED",
                        reason: decision.reason,
                        action,
                        // Include fingerprint in the confirmation decision so ToolExecutor can extract it
                        actionFingerprint: decision.actionFingerprint,
                    };
                }
            }
        }
        return {
            outcome: "allow",
            reasonCode: "ALLOWED",
            reason: `${action.kind} is allowed by policy.`,
            action,
        };
    }
}
exports.PermissionPolicy = PermissionPolicy;
