import crypto from "node:crypto";
import { ContextHydrator } from "../context/hydrator";
import { Compactor } from "../context/compactor";
import { log } from "../logging/logger";
import type { AgentCommand } from "../commands";
import { loadAgentConfig } from "../config/app";
import {
  appendRunStep,
  createRun,
  finishRun,
  getActiveSessionId,
  getRun,
  insertChatMessage,
} from "../storage/repositories";
import type { SkillRegistry } from "../skills/registry";
import type { StandardMessage } from "../types/messages";
import { ToolGateway } from "../tools/gateway";
import type { ToolResult } from "../tools/contracts";
import { AgentToolLoop } from "../tools/loop";

export type ScheduledRunRequest = {
  runId: string;
  scheduleId: string;
  principalId: string;
  chatId: string;
  userRequest: string;
  defaultTimeoutMs?: number;
};

export type ScheduledToolContext = {
  runCommand(action: AgentCommand): Promise<ToolResult>;
};

/**
 * Owns one persisted agent run. Adapters and Router provide transport and
 * command routing; the runtime owns lifecycle, context loading, tool-loop
 * entry, and terminal/pause state transitions.
 */
export class AgentRuntime {
  private readonly hydrator?: ContextHydrator;
  private readonly compactor = new Compactor();
  private readonly gateway = new ToolGateway();
  private readonly activeRuns = new Map<string, { runId: string; controller: AbortController }>();

  constructor(
    registry?: SkillRegistry,
    private readonly toolLoop = new AgentToolLoop(),
  ) {
    if (registry) this.hydrator = new ContextHydrator(registry);
  }

  async execute(
    message: StandardMessage,
    perform: (signal: AbortSignal) => Promise<string>,
  ): Promise<string> {
    insertChatMessage({
      chatId: message.chatId,
      userId: message.userId,
      role: "user",
      content: message.text,
      traceId: message.traceId,
    });
    createRun({
      id: message.traceId,
      session_id: getActiveSessionId(message.chatId),
      principal_id: message.userId,
      channel: message.provider,
      user_request: message.text,
      trace_id: message.traceId,
    });

    const controller = new AbortController();
    const tracksCancellation = message.text.trim().toLowerCase() !== "/stop";
    if (tracksCancellation) this.activeRuns.set(message.chatId, { runId: message.traceId, controller });
    const deadlineMs = loadAgentConfig().runtime?.runDeadlineMs || 30 * 60 * 1000;
    const deadline = setTimeout(() => controller.abort(new Error("Run deadline exceeded.")), deadlineMs);
    try {
      const reply = await perform(controller.signal);
      if (controller.signal.aborted) {
        finishRun(message.traceId, "cancelled", "Run cancelled.");
        return "Run cancelled.";
      }
      insertChatMessage({
        chatId: message.chatId,
        userId: "agent",
        role: "assistant",
        content: reply,
        traceId: message.traceId,
      });
      this.compactor.compactIfNeeded(message.chatId).catch((error) => {
        log.error(message.traceId, "compaction.trigger.failed", { error });
      });
      if (getRun(message.traceId)?.status !== "waiting_approval") {
        finishRun(message.traceId, "completed");
      }
      return reply;
    } catch (error) {
      finishRun(
        message.traceId,
        controller.signal.aborted ? "cancelled" : "failed",
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    } finally {
      clearTimeout(deadline);
      const active = this.activeRuns.get(message.chatId);
      if (active?.runId === message.traceId) this.activeRuns.delete(message.chatId);
    }
  }

  cancelActiveRun(chatId: string): string | null {
    const active = this.activeRuns.get(chatId);
    if (!active) return null;
    active.controller.abort(new Error("Cancelled by owner."));
    return active.runId;
  }

  runAgent(
    message: StandardMessage,
    onReplyMarkup?: (markup: unknown) => void,
    onArtifact?: (artifactId: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (!this.hydrator) throw new Error("AgentRuntime requires a SkillRegistry for agent execution.");
    const context = this.hydrator.hydrate(message);
    return this.toolLoop.run(message, context.prompt, onReplyMarkup, onArtifact, [], message.text, message.traceId, signal);
  }

  prepareCommand(action: AgentCommand, defaultTimeoutMs?: number, userIntent?: string) {
    return this.gateway.prepareCommand(action, defaultTimeoutMs, userIntent);
  }

  async runCommand(
    action: AgentCommand,
    input: {
      runId: string;
      traceId: string;
      chatId: string;
      defaultTimeoutMs?: number;
      confirmationGranted?: boolean;
      userIntent?: string;
      signal?: AbortSignal;
    },
  ): Promise<ToolResult> {
    const result = await this.gateway.runCommand(action, {
      traceId: input.traceId,
      chatId: input.chatId,
      defaultTimeoutMs: input.defaultTimeoutMs,
      confirmationGranted: input.confirmationGranted,
      userIntent: input.userIntent,
      signal: input.signal,
      runId: input.runId,
      sessionId: getActiveSessionId(input.chatId),
      toolCallId: `tc_${crypto.randomUUID()}`,
    });
    appendRunStep({
      runId: input.runId,
      toolName: `command.${action.name || action.label}`,
      call: { action, userIntent: input.userIntent },
      result,
    });
    return result;
  }

  /**
   * Scheduler-only entry point. It creates a persisted run when one does not
   * already exist (manual schedule runs are nested in the adapter run), then
   * gives the callback the sole command-dispatch path through ToolGateway.
   */
  async executeScheduled<T extends { status: "success" | "failed" }>(
    request: ScheduledRunRequest,
    perform: (tools: ScheduledToolContext) => Promise<T>,
  ): Promise<T> {
    const ownsRun = !getRun(request.runId);
    if (ownsRun) {
      createRun({
        id: request.runId,
        session_id: `schedule:${request.scheduleId}`,
        principal_id: request.principalId,
        channel: "scheduler",
        user_request: request.userRequest,
        trace_id: request.runId,
      });
    }
    try {
      const result = await perform({
        runCommand: (action) => this.runCommand(action, {
          runId: request.runId,
          traceId: request.runId,
          chatId: request.chatId,
          defaultTimeoutMs: request.defaultTimeoutMs,
          confirmationGranted: true,
          userIntent: request.userRequest,
        }),
      });
      if (ownsRun) finishRun(request.runId, result.status === "success" ? "completed" : "failed");
      return result;
    } catch (error) {
      if (ownsRun) finishRun(request.runId, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
