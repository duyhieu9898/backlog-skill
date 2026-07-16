"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRuntime = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const hydrator_1 = require("../context/hydrator");
const compactor_1 = require("../context/compactor");
const logger_1 = require("../logging/logger");
const app_1 = require("../config/app");
const repositories_1 = require("../storage/repositories");
const gateway_1 = require("../tools/gateway");
const loop_1 = require("../tools/loop");
/**
 * Owns one persisted agent run. Adapters and Router provide transport and
 * command routing; the runtime owns lifecycle, context loading, tool-loop
 * entry, and terminal/pause state transitions.
 */
class AgentRuntime {
    toolLoop;
    hydrator;
    compactor = new compactor_1.Compactor();
    gateway = new gateway_1.ToolGateway();
    activeRuns = new Map();
    constructor(registry, toolLoop = new loop_1.AgentToolLoop()) {
        this.toolLoop = toolLoop;
        if (registry)
            this.hydrator = new hydrator_1.ContextHydrator(registry);
    }
    async execute(message, perform) {
        (0, repositories_1.insertChatMessage)({
            chatId: message.chatId,
            userId: message.userId,
            role: "user",
            content: message.text,
            traceId: message.traceId,
        });
        (0, repositories_1.createRun)({
            id: message.traceId,
            session_id: (0, repositories_1.getActiveSessionId)(message.chatId),
            principal_id: message.userId,
            channel: message.provider,
            user_request: message.text,
            trace_id: message.traceId,
        });
        const controller = new AbortController();
        const tracksCancellation = message.text.trim().toLowerCase() !== "/stop";
        if (tracksCancellation)
            this.activeRuns.set(message.chatId, { runId: message.traceId, controller });
        const deadlineMs = (0, app_1.loadAgentConfig)().runtime?.runDeadlineMs || 30 * 60 * 1000;
        const deadline = setTimeout(() => controller.abort(new Error("Run deadline exceeded.")), deadlineMs);
        try {
            const reply = await perform(controller.signal);
            if (controller.signal.aborted) {
                (0, repositories_1.finishRun)(message.traceId, "cancelled", "Run cancelled.");
                return "Run cancelled.";
            }
            (0, repositories_1.insertChatMessage)({
                chatId: message.chatId,
                userId: "agent",
                role: "assistant",
                content: reply,
                traceId: message.traceId,
            });
            this.compactor.compactIfNeeded(message.chatId).catch((error) => {
                logger_1.log.error(message.traceId, "compaction.trigger.failed", { error });
            });
            if ((0, repositories_1.getRun)(message.traceId)?.status !== "waiting_approval") {
                (0, repositories_1.finishRun)(message.traceId, "completed");
            }
            return reply;
        }
        catch (error) {
            (0, repositories_1.finishRun)(message.traceId, controller.signal.aborted ? "cancelled" : "failed", error instanceof Error ? error.message : String(error));
            throw error;
        }
        finally {
            clearTimeout(deadline);
            const active = this.activeRuns.get(message.chatId);
            if (active?.runId === message.traceId)
                this.activeRuns.delete(message.chatId);
        }
    }
    cancelActiveRun(chatId) {
        const active = this.activeRuns.get(chatId);
        if (!active)
            return null;
        active.controller.abort(new Error("Cancelled by owner."));
        return active.runId;
    }
    runAgent(message, onReplyMarkup, onArtifact, signal) {
        if (!this.hydrator)
            throw new Error("AgentRuntime requires a SkillRegistry for agent execution.");
        const context = this.hydrator.hydrate(message);
        return this.toolLoop.run(message, context.prompt, onReplyMarkup, onArtifact, [], message.text, message.traceId, signal);
    }
    prepareCommand(action, defaultTimeoutMs, userIntent) {
        return this.gateway.prepareCommand(action, defaultTimeoutMs, userIntent);
    }
    async runCommand(action, input) {
        const result = await this.gateway.runCommand(action, {
            traceId: input.traceId,
            chatId: input.chatId,
            defaultTimeoutMs: input.defaultTimeoutMs,
            confirmationGranted: input.confirmationGranted,
            userIntent: input.userIntent,
            signal: input.signal,
            runId: input.runId,
            sessionId: (0, repositories_1.getActiveSessionId)(input.chatId),
            toolCallId: `tc_${node_crypto_1.default.randomUUID()}`,
        });
        (0, repositories_1.appendRunStep)({
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
    async executeScheduled(request, perform) {
        const ownsRun = !(0, repositories_1.getRun)(request.runId);
        if (ownsRun) {
            (0, repositories_1.createRun)({
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
            if (ownsRun)
                (0, repositories_1.finishRun)(request.runId, result.status === "success" ? "completed" : "failed");
            return result;
        }
        catch (error) {
            if (ownsRun)
                (0, repositories_1.finishRun)(request.runId, "failed", error instanceof Error ? error.message : String(error));
            throw error;
        }
    }
}
exports.AgentRuntime = AgentRuntime;
