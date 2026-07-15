import type { AiToolCall, AiToolDefinition, AiToolScope } from "../brain/provider";
import { evaluateCommandPermission, type AgentCommand } from "../commands";
import { loadAgentConfig } from "../config/app";
import { PermissionPolicy } from "../security/permissionPolicy";
import { getDesktopAdapter } from "./computer/linux-x11";
import type { FileToolAction, ToolResult } from "./contracts";
import { browserConfirmationStore } from "../security/browser-confirmation";
import { computeActionFingerprint } from "../browser/action-policy";
import { ToolExecutor, buildBrowserActionPolicyContext, computerController, type PreparedToolCall } from "./executor";
import { ensureToolsRegistered } from "./register-tools";
import { deriveActionProfile } from "../security/actionProfile";

/**
 * The only runtime entry point for LLM-originated tool calls.
 *
 * It resolves and validates a call, evaluates permission, then returns an
 * executable call only after that decision. ToolExecutor never performs work
 * during preparation.
 */
export class ToolGateway {
  constructor(private readonly executor = new ToolExecutor()) {
    ensureToolsRegistered();
  }

  definitions(scope?: AiToolScope): AiToolDefinition[] {
    return this.executor.definitions(scope);
  }

  /** Resolve, validate, and attach an action profile — without authorizing. */
  prepareRaw(call: AiToolCall, traceId: string, definitions?: AiToolDefinition[], chatId?: string): PreparedToolCall {
    const prepared = this.executor.prepare(call, traceId, definitions, chatId);
    return { ...prepared, profile: deriveActionProfile(prepared) };
  }

  /** Authorize an already-prepared call (e.g. after checking grant coverage). */
  authorizePrepared(prepared: PreparedToolCall, chatId?: string): PreparedToolCall {
    return this.authorize(prepared, chatId);
  }

  prepare(call: AiToolCall, traceId: string, definitions?: AiToolDefinition[], chatId?: string, userIntent?: string, approvalGranted = false): PreparedToolCall {
    const prepared = this.prepareRaw(call, traceId, definitions, chatId);
    return this.authorize({ ...prepared, userIntent, approvalGranted }, chatId);
  }

  prepareCommand(action: AgentCommand, defaultTimeoutMs?: number, userIntent?: string, approvalGranted = false): PreparedToolCall {
    return this.authorize({ ...this.executor.prepareCommand(action, defaultTimeoutMs), userIntent, approvalGranted });
  }

  private authorize(prepared: PreparedToolCall, chatId?: string): PreparedToolCall {
    if (prepared.blocked) return prepared;

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
      const decision = evaluateCommandPermission(prepared.command, prepared.approvalGranted, prepared.userIntent);
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
      const decision = new PermissionPolicy(loadAgentConfig().permissions).evaluate(prepared.fileAction, { confirmationGranted: prepared.approvalGranted });
      if (decision.outcome === "deny") {
        return { ...prepared, requiresConfirmation: false, preview: decision.reason, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
      }
      return {
        ...prepared,
        fileAction: decision.action as FileToolAction,
        requiresConfirmation: decision.outcome === "confirm",
        preview: decision.outcome === "confirm" ? `${decision.reason}\n${prepared.preview}` : prepared.preview,
      };
    }

    if (prepared.desktopAction && prepared.computerInput) {
      const adapter = getDesktopAdapter();
      const inputAction = prepared.computerInput.action;
      const leaseActive = inputAction !== "screenshot" && inputAction !== "launch" && Boolean(chatId && computerController.hasLease(chatId));
      const decision = new PermissionPolicy(loadAgentConfig().permissions).evaluate(prepared.desktopAction, {
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
      const args = prepared.call.arguments as Record<string, any>;
      const browserContext = buildBrowserActionPolicyContext(args, prepared.browserAction.kind);
      const decision = new PermissionPolicy(loadAgentConfig().permissions).evaluate(prepared.browserAction, { browserContext });
      if (prepared.approvalGranted) {
        const approved = new PermissionPolicy(loadAgentConfig().permissions).evaluate(prepared.browserAction, { browserContext, confirmationGranted: true });
        if (approved.outcome === "deny") {
          return { ...prepared, requiresConfirmation: false, preview: approved.reason, blocked: { ok: false, code: approved.reasonCode, summary: approved.reason } };
        }
        return { ...prepared, requiresConfirmation: false };
      }
      if (decision.outcome === "deny") {
        return { ...prepared, requiresConfirmation: false, preview: decision.reason, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
      }
      if (decision.outcome === "confirm") {
        const actionFingerprint = (decision as any).actionFingerprint || "";
        browserConfirmationStore.createGrant({
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

  execute(prepared: PreparedToolCall, context: { traceId: string; chatId: string; confirmationGranted?: boolean; signal?: AbortSignal }): Promise<ToolResult> | ToolResult {
    if (context.signal?.aborted) return { ok: false, code: "RUN_CANCELLED", summary: "Run was cancelled before tool execution." };
    const approvalGranted = context.confirmationGranted || prepared.approvalGranted;
    if (prepared.desktopAction && prepared.computerInput) {
      const inputAction = prepared.computerInput.action;
      const leaseActive = inputAction !== "screenshot" && inputAction !== "launch" && computerController.hasLease(context.chatId);
      const decision = new PermissionPolicy(loadAgentConfig().permissions).evaluate(prepared.desktopAction, {
        desktopStatus: getDesktopAdapter().getStatus(),
        confirmationGranted: approvalGranted || leaseActive,
      });
      if (decision.outcome !== "allow") return { ok: false, code: decision.reasonCode, summary: decision.reason };
    }
    if (prepared.browserAction) {
      const args = prepared.call.arguments as Record<string, any>;
      const browserContext = buildBrowserActionPolicyContext(args, prepared.browserAction.kind);
      const decision = new PermissionPolicy(loadAgentConfig().permissions).evaluate(prepared.browserAction, {
        browserContext,
        confirmationGranted: approvalGranted,
      });
      if (decision.outcome !== "allow") return { ok: false, code: decision.reasonCode, summary: decision.reason };
      if (approvalGranted && prepared.actionFingerprint && browserContext) {
        const confirmation = browserConfirmationStore.findAndConsume({
          sessionId: browserContext.sessionId,
          runId: browserContext.runId,
          profile: browserContext.profile,
          targetId: browserContext.targetId,
          snapshotId: browserContext.snapshotId,
          actionFingerprint: computeActionFingerprint(browserContext),
        });
        if (!confirmation.valid) return { ok: false, code: confirmation.code, summary: confirmation.reason };
      }
    }
    return this.executor.execute(prepared, {
      ...context,
      confirmationGranted: approvalGranted,
      userIntent: prepared.userIntent,
      gatewayAuthorized: true,
    });
  }

  async runCommand(
    action: AgentCommand,
    context: { traceId: string; chatId: string; defaultTimeoutMs?: number; confirmationGranted?: boolean; userIntent?: string; signal?: AbortSignal },
  ) {
    const prepared = this.prepareCommand(action, context.defaultTimeoutMs, context.userIntent);
    if (prepared.blocked) return prepared.blocked;
    if (prepared.requiresConfirmation && !context.confirmationGranted) {
      return { ok: false, code: "CONFIRMATION_REQUIRED", summary: prepared.preview };
    }
    return this.execute(prepared, context);
  }
}
