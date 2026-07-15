"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolGateway = void 0;
const commands_1 = require("../commands");
const app_1 = require("../config/app");
const permissionPolicy_1 = require("../security/permissionPolicy");
const linux_x11_1 = require("./computer/linux-x11");
const browser_confirmation_1 = require("../security/browser-confirmation");
const action_policy_1 = require("../browser/action-policy");
const executor_1 = require("./executor");
const register_tools_1 = require("./register-tools");
const actionProfile_1 = require("../security/actionProfile");
/**
 * The only runtime entry point for LLM-originated tool calls.
 *
 * It resolves and validates a call, evaluates permission, then returns an
 * executable call only after that decision. ToolExecutor never performs work
 * during preparation.
 */
class ToolGateway {
    executor;
    constructor(executor = new executor_1.ToolExecutor()) {
        this.executor = executor;
        (0, register_tools_1.ensureToolsRegistered)();
    }
    definitions(scope) {
        return this.executor.definitions(scope);
    }
    /** Resolve, validate, and attach an action profile — without authorizing. */
    prepareRaw(call, traceId, definitions, chatId) {
        const prepared = this.executor.prepare(call, traceId, definitions, chatId);
        return { ...prepared, profile: (0, actionProfile_1.deriveActionProfile)(prepared) };
    }
    /** Authorize an already-prepared call (e.g. after checking grant coverage). */
    authorizePrepared(prepared, chatId) {
        return this.authorize(prepared, chatId);
    }
    prepare(call, traceId, definitions, chatId, userIntent, approvalGranted = false) {
        const prepared = this.prepareRaw(call, traceId, definitions, chatId);
        return this.authorize({ ...prepared, userIntent, approvalGranted }, chatId);
    }
    prepareCommand(action, defaultTimeoutMs, userIntent, approvalGranted = false) {
        return this.authorize({ ...this.executor.prepareCommand(action, defaultTimeoutMs), userIntent, approvalGranted });
    }
    authorize(prepared, chatId) {
        if (prepared.blocked)
            return prepared;
        if (prepared.customTool) {
            const { risk } = prepared.customTool;
            if (risk === "destructive") {
                return {
                    ...prepared,
                    requiresConfirmation: false,
                    blocked: { ok: false, code: "CUSTOM_TOOL_BLOCKED", summary: `Custom tool ${prepared.call.name} is declared destructive.` },
                };
            }
            if (risk === "sensitive" && !prepared.approvalGranted) {
                return {
                    ...prepared,
                    requiresConfirmation: true,
                    preview: `${prepared.call.name} requires confirmation.\n${prepared.preview}`,
                };
            }
            return prepared;
        }
        if (prepared.command) {
            const decision = (0, commands_1.evaluateCommandPermission)(prepared.command, prepared.approvalGranted, prepared.userIntent);
            if (decision.outcome === "deny") {
                return { ...prepared, requiresConfirmation: false, preview: decision.reason, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
            }
            return {
                ...prepared,
                requiresConfirmation: decision.outcome === "confirm",
                preview: decision.outcome === "confirm" ? `${decision.reason}\n${prepared.preview}` : prepared.preview,
            };
        }
        if (prepared.fileAction) {
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.fileAction, { confirmationGranted: prepared.approvalGranted });
            if (decision.outcome === "deny") {
                return { ...prepared, requiresConfirmation: false, preview: decision.reason, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
            }
            return {
                ...prepared,
                fileAction: decision.action,
                requiresConfirmation: decision.outcome === "confirm",
                preview: decision.outcome === "confirm" ? `${decision.reason}\n${prepared.preview}` : prepared.preview,
            };
        }
        if (prepared.desktopAction && prepared.computerInput) {
            const adapter = (0, linux_x11_1.getDesktopAdapter)();
            const inputAction = prepared.computerInput.action;
            const leaseActive = inputAction !== "screenshot" && inputAction !== "launch" && Boolean(chatId && executor_1.computerController.hasLease(chatId));
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.desktopAction, {
                desktopStatus: adapter.getStatus(),
                confirmationGranted: prepared.approvalGranted,
            });
            if (decision.outcome === "deny") {
                return { ...prepared, requiresConfirmation: false, preview: decision.reason, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
            }
            return {
                ...prepared,
                requiresConfirmation: decision.outcome === "confirm" && !leaseActive,
                preview: decision.outcome === "confirm" ? `${decision.reason}\n${prepared.preview}` : prepared.preview,
            };
        }
        if (prepared.browserAction) {
            const args = prepared.call.arguments;
            const browserContext = (0, executor_1.buildBrowserActionPolicyContext)(args, prepared.browserAction.kind);
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.browserAction, { browserContext });
            if (prepared.approvalGranted) {
                const approved = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.browserAction, { browserContext, confirmationGranted: true });
                if (approved.outcome === "deny") {
                    return { ...prepared, requiresConfirmation: false, preview: approved.reason, blocked: { ok: false, code: approved.reasonCode, summary: approved.reason } };
                }
                return { ...prepared, requiresConfirmation: false };
            }
            if (decision.outcome === "deny") {
                return { ...prepared, requiresConfirmation: false, preview: decision.reason, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
            }
            if (decision.outcome === "confirm") {
                const actionFingerprint = decision.actionFingerprint || "";
                browser_confirmation_1.browserConfirmationStore.createGrant({
                    sessionId: "sess-1",
                    runId: "run-1",
                    profile: args.profile || "default",
                    targetId: args.targetId || "",
                    snapshotId: args.request?.snapshotId,
                    actionFingerprint,
                });
                return {
                    ...prepared,
                    requiresConfirmation: true,
                    actionFingerprint,
                    preview: `${decision.reason}\nAction: ${prepared.preview}`,
                };
            }
        }
        return prepared;
    }
    execute(prepared, context) {
        if (context.signal?.aborted)
            return { ok: false, code: "RUN_CANCELLED", summary: "Run was cancelled before tool execution." };
        const approvalGranted = context.confirmationGranted || prepared.approvalGranted;
        if (prepared.desktopAction && prepared.computerInput) {
            const inputAction = prepared.computerInput.action;
            const leaseActive = inputAction !== "screenshot" && inputAction !== "launch" && executor_1.computerController.hasLease(context.chatId);
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.desktopAction, {
                desktopStatus: (0, linux_x11_1.getDesktopAdapter)().getStatus(),
                confirmationGranted: approvalGranted || leaseActive,
            });
            if (decision.outcome !== "allow")
                return { ok: false, code: decision.reasonCode, summary: decision.reason };
        }
        if (prepared.browserAction) {
            const args = prepared.call.arguments;
            const browserContext = (0, executor_1.buildBrowserActionPolicyContext)(args, prepared.browserAction.kind);
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.browserAction, {
                browserContext,
                confirmationGranted: approvalGranted,
            });
            if (decision.outcome !== "allow")
                return { ok: false, code: decision.reasonCode, summary: decision.reason };
            if (approvalGranted && prepared.actionFingerprint && browserContext) {
                const confirmation = browser_confirmation_1.browserConfirmationStore.findAndConsume({
                    sessionId: browserContext.sessionId,
                    runId: browserContext.runId,
                    profile: browserContext.profile,
                    targetId: browserContext.targetId,
                    snapshotId: browserContext.snapshotId,
                    actionFingerprint: (0, action_policy_1.computeActionFingerprint)(browserContext),
                });
                if (!confirmation.valid)
                    return { ok: false, code: confirmation.code, summary: confirmation.reason };
            }
        }
        return this.executor.execute(prepared, {
            ...context,
            confirmationGranted: approvalGranted,
            userIntent: prepared.userIntent,
            gatewayAuthorized: true,
        });
    }
    async runCommand(action, context) {
        const prepared = this.prepareCommand(action, context.defaultTimeoutMs, context.userIntent);
        if (prepared.blocked)
            return prepared.blocked;
        if (prepared.requiresConfirmation && !context.confirmationGranted) {
            return { ok: false, code: "CONFIRMATION_REQUIRED", summary: prepared.preview };
        }
        return this.execute(prepared, context);
    }
}
exports.ToolGateway = ToolGateway;
