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
const logger_1 = require("../logging/logger");
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
    prepareCommand(action, defaultTimeoutMs, userIntent, approvalGranted = false, audit) {
        return this.authorize({ ...this.executor.prepareCommand(action, defaultTimeoutMs), userIntent, approvalGranted, audit });
    }
    /** Authorize, then emit the gateway decision audit record. */
    authorize(prepared, chatId) {
        const result = this.authorizeCore(prepared, chatId);
        this.auditDecision(result);
        return result;
    }
    authorizeCore(prepared, chatId) {
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
    async execute(prepared, context) {
        if (context.signal?.aborted) {
            const cancelled = { ok: false, code: "RUN_CANCELLED", summary: "Run was cancelled before tool execution." };
            this.auditExecuted(prepared, cancelled);
            return cancelled;
        }
        // A denied call was already audited as a deny decision at authorize(); it is
        // not an execution result, so do not emit gateway.executed for it.
        if (prepared.blocked)
            return prepared.blocked;
        const approvalGranted = context.confirmationGranted || prepared.approvalGranted;
        if (prepared.desktopAction && prepared.computerInput) {
            const inputAction = prepared.computerInput.action;
            const leaseActive = inputAction !== "screenshot" && inputAction !== "launch" && executor_1.computerController.hasLease(context.chatId);
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.desktopAction, {
                desktopStatus: (0, linux_x11_1.getDesktopAdapter)().getStatus(),
                confirmationGranted: approvalGranted || leaseActive,
            });
            if (decision.outcome !== "allow") {
                this.auditExecuteDeny(prepared, decision.reasonCode, decision.reason);
                return { ok: false, code: decision.reasonCode, summary: decision.reason };
            }
        }
        if (prepared.browserAction) {
            const args = prepared.call.arguments;
            const browserContext = (0, executor_1.buildBrowserActionPolicyContext)(args, prepared.browserAction.kind);
            const decision = new permissionPolicy_1.PermissionPolicy((0, app_1.loadAgentConfig)().permissions).evaluate(prepared.browserAction, {
                browserContext,
                confirmationGranted: approvalGranted,
            });
            if (decision.outcome !== "allow") {
                this.auditExecuteDeny(prepared, decision.reasonCode, decision.reason);
                return { ok: false, code: decision.reasonCode, summary: decision.reason };
            }
            if (approvalGranted && prepared.actionFingerprint && browserContext) {
                const confirmation = browser_confirmation_1.browserConfirmationStore.findAndConsume({
                    sessionId: browserContext.sessionId,
                    runId: browserContext.runId,
                    profile: browserContext.profile,
                    targetId: browserContext.targetId,
                    snapshotId: browserContext.snapshotId,
                    actionFingerprint: (0, action_policy_1.computeActionFingerprint)(browserContext),
                });
                if (!confirmation.valid) {
                    this.auditExecuteDeny(prepared, confirmation.code, confirmation.reason);
                    return { ok: false, code: confirmation.code, summary: confirmation.reason };
                }
            }
        }
        const result = await this.executor.execute(prepared, {
            ...context,
            confirmationGranted: approvalGranted,
            userIntent: prepared.userIntent,
            gatewayAuthorized: true,
        });
        this.auditExecuted(prepared, result);
        return result;
    }
    async runCommand(action, context) {
        const audit = context.runId && context.sessionId && context.toolCallId
            ? { traceId: context.traceId, sessionId: context.sessionId, runId: context.runId, toolCallId: context.toolCallId }
            : undefined;
        const prepared = this.prepareCommand(action, context.defaultTimeoutMs, context.userIntent, false, audit);
        if (prepared.blocked)
            return prepared.blocked;
        if (prepared.requiresConfirmation && !context.confirmationGranted) {
            return { ok: false, code: "CONFIRMATION_REQUIRED", summary: prepared.preview };
        }
        return this.execute(prepared, context);
    }
    /** Emit the authorize() decision (allow / confirm / deny). No-op without an audit context. */
    auditDecision(prepared) {
        const audit = prepared.audit;
        if (!audit)
            return;
        const outcome = prepared.blocked ? "deny" : prepared.requiresConfirmation ? "confirm" : "allow";
        logger_1.log.info(audit.traceId, "gateway.decision", {
            traceId: audit.traceId,
            sessionId: audit.sessionId,
            runId: audit.runId,
            toolCallId: audit.toolCallId,
            outcome,
            stage: "authorize",
            toolName: prepared.call.name,
            toolKey: prepared.key,
            digest: prepared.digest,
            reasonCode: prepared.blocked?.code,
            reason: prepared.blocked?.summary,
        });
    }
    /** Emit an execute() defense-in-depth deny. No-op without an audit context. */
    auditExecuteDeny(prepared, code, summary) {
        const audit = prepared.audit;
        if (!audit)
            return;
        logger_1.log.info(audit.traceId, "gateway.decision", {
            traceId: audit.traceId,
            sessionId: audit.sessionId,
            runId: audit.runId,
            toolCallId: audit.toolCallId,
            outcome: "deny",
            stage: "execute_recheck",
            toolName: prepared.call.name,
            toolKey: prepared.key,
            digest: prepared.digest,
            reasonCode: code,
            reason: summary,
        });
    }
    /** Emit the execution result. No-op without an audit context. */
    auditExecuted(prepared, result) {
        const audit = prepared.audit;
        if (!audit)
            return;
        logger_1.log.info(audit.traceId, "gateway.executed", {
            traceId: audit.traceId,
            sessionId: audit.sessionId,
            runId: audit.runId,
            toolCallId: audit.toolCallId,
            ok: result.ok,
            code: result.code,
            summary: result.summary,
            toolName: prepared.call.name,
            toolKey: prepared.key,
        });
    }
}
exports.ToolGateway = ToolGateway;
