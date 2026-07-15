"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deriveActionProfile = deriveActionProfile;
const commands_1 = require("../commands");
const permissionPolicy_1 = require("./permissionPolicy");
const policy_patterns_1 = require("./policy-patterns");
function safeCanonical(candidate) {
    if (!candidate)
        return undefined;
    try {
        return (0, permissionPolicy_1.canonicalizePolicyPath)(candidate);
    }
    catch {
        return candidate;
    }
}
function urlOrigin(raw) {
    if (typeof raw !== "string" || !raw)
        return undefined;
    try {
        return new URL(raw).origin;
    }
    catch {
        return undefined;
    }
}
function commandRisk(prepared) {
    const command = prepared.command;
    const preview = (0, commands_1.previewCommand)(command);
    const cmdLike = {
        kind: "command.run",
        commandId: command.name || "command.run",
        executable: preview.executable,
        args: preview.args,
        shellCommand: preview.shellCommand,
        cwd: preview.cwd,
        requiresConfirmation: preview.requiresConfirmation,
        externalSideEffect: preview.externalSideEffect,
    };
    if ((0, policy_patterns_1.isClearlyDestructiveCommand)(cmdLike))
        return "destructive";
    if ((0, policy_patterns_1.needsSystemApproval)(cmdLike))
        return "system-impact";
    if (preview.externalSideEffect)
        return "external-side-effect";
    return "routine";
}
/**
 * Derive an {@link ActionProfile} from a prepared tool call. Reuses the same
 * classification primitives as PermissionPolicy so the grant axis matches the
 * policy decision.
 */
function deriveActionProfile(prepared) {
    if (prepared.command) {
        const preview = (0, commands_1.previewCommand)(prepared.command);
        const cwd = safeCanonical(preview.cwd);
        return {
            family: "command",
            riskCategory: commandRisk(prepared),
            resourceHints: cwd ? [cwd] : [],
            commandHints: [prepared.call.name],
        };
    }
    if (prepared.fileAction) {
        const path = prepared.fileAction.path;
        const canonical = safeCanonical(path);
        return {
            family: "file",
            riskCategory: (0, policy_patterns_1.isSecretLike)(path) ? "sensitive" : "routine",
            resourceHints: canonical ? [canonical] : [],
            commandHints: [prepared.call.name],
        };
    }
    if (prepared.desktopAction) {
        const action = prepared.desktopAction;
        return {
            family: "desktop",
            riskCategory: "routine",
            resourceHints: action.kind === "desktop.launch" ? [action.appId] : [],
            commandHints: [action.kind],
        };
    }
    if (prepared.browserAction) {
        const args = prepared.call.arguments;
        const origin = urlOrigin(args.url);
        return {
            family: "browser",
            // Browser confirmations stay snapshot/fingerprint-bound; this profile
            // never matches a widened grant because resolve() stores no commandHints
            // for browser actions (approvalHints returns []).
            riskCategory: "approved-action",
            resourceHints: origin ? [origin] : [],
            commandHints: [prepared.browserAction.kind],
        };
    }
    if (prepared.customTool) {
        const risk = prepared.customTool.risk;
        return {
            family: "custom",
            riskCategory: risk === "destructive" ? "destructive" : risk === "sensitive" ? "sensitive" : "routine",
            resourceHints: [],
            commandHints: [prepared.customTool.name],
        };
    }
    return {
        family: "custom",
        riskCategory: "routine",
        resourceHints: [],
        commandHints: prepared.call.name ? [prepared.call.name] : [],
    };
}
