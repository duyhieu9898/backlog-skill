import { AiRouter } from "../brain/router";
import type { AiPromptContext, AiToolCall, AiToolDefinition, AiToolStep } from "../brain/provider";
import { log } from "../logging/logger";
import type { StandardMessage } from "../types/messages";
import { ToolGateway } from "./gateway";
import { ApprovalService } from "../security/approvalService";
import { appendRunStep, finishRun, getActiveSessionId } from "../storage/repositories";
import type { ActionProfile } from "../security/actionProfile";
import type { ToolResult } from "./contracts";
import { ArtifactStore } from "../artifacts/store";
import { createModelImage } from "./media/image-context";
import fs from "node:fs";
import crypto from "node:crypto";

const MAX_TOOL_STEPS = 8;
const MAX_IDENTICAL_FAILURES = 2;

type PendingAiTool = {
  kind: "ai-tool";
  call: AiToolCall;
  digest: string;
  preview: string;
  profile?: ActionProfile;
  toolCallId?: string;
  /**
   * The confirmation message is not the user's task. Keep the original model
   * context so approving one action can resume the same tool loop instead of
   * turning confirmation into a terminal one-shot command.
   */
  continuation?: {
    userMessage: string;
    context: AiPromptContext;
    steps: Array<Omit<AiToolStep, "image">>;
  };
};

function formatResult(result: ToolResult): string {
  const data = result.data === undefined ? "" : `\n${JSON.stringify(result.data, null, 2)}`;
  return `${result.ok ? "Tool completed" : "Tool failed"} [${result.code}]\n${result.summary}${data}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function failureKey(call: AiToolCall, result: ToolResult): string {
  return `${call.name}:${stableJson(call.arguments)}:${result.code}`;
}

function modelImageForResult(result: ToolResult, chatId: string) {
  const artifactId = (result.data as { artifactId?: unknown } | undefined)?.artifactId;
  if (typeof artifactId !== "string") return undefined;
  try {
    const artifact = new ArtifactStore().claim(artifactId, chatId);
    return createModelImage(fs.readFileSync(artifact.local_path), artifact.mime_type);
  } catch {
    return undefined;
  }
}

function persistentSteps(steps: AiToolStep[]): Array<Omit<AiToolStep, "image">> {
  // Screenshots are re-read from their artifact when the loop resumes. Never
  // put base64 pixels in the pending-confirmation database row.
  return steps.map(({ call, result }) => ({ call, result }));
}

function appendStep(
  runId: string,
  steps: AiToolStep[],
  step: AiToolStep,
): void {
  steps.push(step);
  appendRunStep({ runId, toolName: step.call.name, call: step.call, result: step.result });
}

function repeatedFailureMessage(call: AiToolCall, result: ToolResult): string {
  return [
    `Đã dừng sau ${MAX_IDENTICAL_FAILURES} lần lỗi lặp lại cho ${call.name} [${result.code}] để tránh hao token.`,
    result.summary,
    "Hãy thay đổi tham số, chọn tool khác, hoặc gửi yêu cầu rõ hơn trước khi thử lại.",
  ].join("\n");
}

/** Identity of a tool call (name + canonical args), used to detect a repeat. */
function callKey(call: AiToolCall): string {
  return `${call.name}:${stableJson(call.arguments)}`;
}

function repeatedSuccessMessage(call: AiToolCall): string {
  return [
    `Đã dừng: "${call.name}" lặp lại y hệt bước vừa thành công — khả năng model bị loop.`,
    "Nếu thực sự cần làm lại, hãy thay đổi tham số hoặc chọn tool khác.",
  ].join("\n");
}

export class AgentToolLoop {
  private readonly approvals = new ApprovalService();
  constructor(
    private readonly ai = new AiRouter(),
    private readonly gateway = new ToolGateway(),
  ) {}

  /** Prepare, then authorize with grant coverage derived from the action profile. */
  private prepareAuthorized(
    call: AiToolCall,
    message: StandardMessage,
    runId: string,
    sessionId: string,
    toolCallId: string,
    tools?: AiToolDefinition[],
    userMessage?: string,
    approvalGranted = false,
  ) {
    const raw = this.gateway.prepareRaw(call, message.traceId, tools, message.chatId);
    const covered = raw.profile
      ? this.approvals.covers({ principalId: message.userId, runId, sessionId, profile: raw.profile })
      : false;
    return this.gateway.authorizePrepared(
      {
        ...raw,
        userIntent: userMessage,
        approvalGranted: covered || approvalGranted,
        audit: { traceId: message.traceId, sessionId, runId, toolCallId },
      },
      message.chatId,
    );
  }

  async run(
    message: StandardMessage,
    context: AiPromptContext,
    onReplyMarkup?: (markup: unknown) => void,
    onArtifact?: (artifactId: string) => void,
    initialSteps: AiToolStep[] = [],
    userMessage = message.text,
    runId = message.traceId,
    signal?: AbortSignal,
  ): Promise<string> {
    const steps: AiToolStep[] = [...initialSteps];
    const failures = new Map<string, number>();
    const route = context.capabilityRoute;
    const tools = this.gateway.definitions(route);
    const snapshot = {
      names: tools.map((tool) => tool.name),
      schemaHash: crypto.createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
    };
    const sessionId = getActiveSessionId(message.chatId);
    log.info(message.traceId, "ai.tool.visibility.selected", {
      capabilities: route?.capabilities || [],
      continuation: route?.continuation || "new",
      confidence: route?.confidence || "low",
      selectionReason: route?.selectionReason || "legacy context",
      visibleToolNames: snapshot.names,
      schemaHash: snapshot.schemaHash,
    });

    for (let index = 0; index < MAX_TOOL_STEPS; index += 1) {
      if (signal?.aborted) return "Run cancelled.";
      const response = await this.ai.complete(message.traceId, context, userMessage, tools, steps);
      if (response.clarification) {
        log.info(message.traceId, "ai.clarification.requested", { step: index });
        return response.clarification;
      }
      if (response.text) return response.text;
      if (!response.toolCall) throw new Error("AI response did not contain a valid outcome.");

      const toolCallId = `tc_${crypto.randomUUID()}`;
      log.info(message.traceId, "ai.tool.selected", {
        step: index,
        toolName: response.toolCall.name,
      });
      // Repeated-success guard: if the model re-issues the exact same call that just
      // SUCCEEDED, it's a degenerate loop (e.g. capturing the same URL 6× in a row).
      // Stop before executing the redundant call — avoids wasted captures/artifacts
      // and the blunt MAX_TOOL_STEPS cap producing "Đã dừng sau 8 bước". A retry after
      // a failure is not blocked (the prior step's result.ok would be false).
      const lastStep = steps[steps.length - 1];
      if (lastStep && (lastStep.result as ToolResult).ok && callKey(response.toolCall) === callKey(lastStep.call)) {
        log.warn(message.traceId, "ai.tool.repeated_success_stopped", { step: index, toolName: response.toolCall.name });
        return repeatedSuccessMessage(response.toolCall);
      }
      try {
        const prepared = this.prepareAuthorized(response.toolCall, message, runId, sessionId, toolCallId, tools, userMessage);
        if (prepared.requiresConfirmation) {
          const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
          const pending: PendingAiTool = {
            kind: "ai-tool",
            call: prepared.call,
            digest: prepared.digest,
            preview: prepared.preview,
            profile: prepared.profile,
            toolCallId,
            continuation: {
              userMessage,
              context,
              steps: persistentSteps(steps),
            },
          };
          const approval = this.approvals.create({
            runId, principalId: message.userId, chatId: message.chatId,
            description: `Cho phép chạy ${prepared.key} trong run này.`,
            actionDigest: prepared.digest, payload: pending, expiresAt,
          });
          log.info(message.traceId, "ai.tool.confirmation_required", {
            toolName: prepared.call.name,
            confirmationKey: prepared.key,
          });
          onReplyMarkup?.({
            inline_keyboard: [
              [
                {
                  text: "✅ Approve", callback_data: `approve ${approval.short_id}`,
                },
                {
                  text: "❌ Reject", callback_data: `reject ${approval.short_id}`,
                },
              ],
            ],
          });
          return [
            `${prepared.key} cần xác nhận trước khi chạy.`,
            prepared.preview,
            `Approval ID: ${approval.short_id}`,
            `Gõ: approve ${approval.short_id} hoặc reject ${approval.short_id}`,
          ].join("\n");
        }

        const result = await this.gateway.execute(prepared, {
          traceId: message.traceId,
          chatId: message.chatId,
          signal,
        });

        let finalResult = result;
        let finalCall = response.toolCall;

        // Ref freshness failures are returned to the model as structured tool
        // results. The model must take a new snapshot and choose a new ref;
        // the runtime never translates an old ref into a fresh one.

        if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(finalResult.code) && typeof (finalResult.data as { artifactId?: unknown } | undefined)?.artifactId === "string") {
          onArtifact?.((finalResult.data as { artifactId: string }).artifactId);
        }
        appendStep(runId, steps, { call: finalCall, result: finalResult, image: modelImageForResult(finalResult, message.chatId) });
        log.info(message.traceId, "ai.tool.completed", {
          step: index,
          toolName: finalCall.name,
          ok: finalResult.ok,
          code: finalResult.code,
        });
        if (!result.ok) {
          const key = failureKey(response.toolCall, result);
          const attempts = (failures.get(key) || 0) + 1;
          failures.set(key, attempts);
          if (attempts >= MAX_IDENTICAL_FAILURES) {
            log.warn(message.traceId, "ai.tool.repeated_failure_stopped", {
              step: index,
              toolName: response.toolCall.name,
              code: result.code,
              attempts,
            });
            return repeatedFailureMessage(response.toolCall, result);
          }
        }
      } catch (error) {
        const result: ToolResult = {
          ok: false,
          code: "INVALID_TOOL_CALL",
          summary: error instanceof Error ? error.message : String(error),
        };
        appendStep(runId, steps, { call: response.toolCall, result });
        log.warn(message.traceId, "ai.tool.rejected", {
          step: index,
          toolName: response.toolCall.name,
          reason: result.summary,
        });
        const key = failureKey(response.toolCall, result);
        const attempts = (failures.get(key) || 0) + 1;
        failures.set(key, attempts);
        if (attempts >= MAX_IDENTICAL_FAILURES) {
          log.warn(message.traceId, "ai.tool.repeated_failure_stopped", {
            step: index,
            toolName: response.toolCall.name,
            code: result.code,
            attempts,
          });
          return repeatedFailureMessage(response.toolCall, result);
        }
      }
    }

    return [
    `Đã dừng sau ${MAX_TOOL_STEPS} bước tool.`,
    "Nếu task chưa hoàn thành, hãy gõ \"tiếp tục\" để tiếp tục hoặc thu hẹp yêu cầu thành các bước nhỏ hơn.",
  ].join("\n");
  }

  async consumeScopedApproval(message: StandardMessage, onArtifact?: (artifactId: string) => void, onReplyMarkup?: (markup: unknown) => void, signal?: AbortSignal): Promise<string | null> {
    const match = message.text.trim().toLowerCase().match(/^(approve|reject)\s+([a-f0-9]{8})$/);
    if (!match) return null;
    const candidate = this.approvals.get(match[2], message.userId, message.chatId);
    if (!candidate) return null;
    let payload: PendingAiTool;
    try { payload = JSON.parse(candidate.payload_json) as PendingAiTool; } catch { return null; }
    if (payload.kind !== "ai-tool") return null;
    let prepared;
    try {
      const resumeSessionId = getActiveSessionId(message.chatId);
      const resumeToolCallId = payload.toolCallId ?? `tc_${crypto.randomUUID()}`;
      prepared = this.prepareAuthorized(payload.call, message, candidate.run_id, resumeSessionId, resumeToolCallId, undefined, payload.continuation?.userMessage, match[1] === "approve");
    } catch { return "Approval không còn hợp lệ."; }
    const pending = this.approvals.resolve({ shortId: match[2], principalId: message.userId, chatId: message.chatId, actionDigest: prepared.digest, approve: match[1] === "approve" });
    if (!pending) return "Approval không tồn tại, đã hết hạn, hoặc action đã thay đổi.";
    if (match[1] === "reject") return "Đã từ chối action đang chờ.";
    const result = await this.gateway.execute(prepared, { traceId: message.traceId, chatId: message.chatId, confirmationGranted: true });
    if (typeof (result.data as { artifactId?: unknown } | undefined)?.artifactId === "string") onArtifact?.((result.data as { artifactId: string }).artifactId);
    if (!payload.continuation) {
      finishRun(pending.run_id, result.ok ? "completed" : "failed", result.ok ? undefined : result.summary);
      return formatResult(result);
    }
    // US-027 mảng 4: selective hydrate on resume. Continuation steps are
    // historical — they replay as text/observation markers, never re-read as
    // base64. Only the step about to become current (the freshly executed action)
    // hydrates inline bytes, keeping the resumed turn inside the image budget.
    const steps = payload.continuation.steps.map((step) => ({ ...step }));
    appendStep(pending.run_id, steps, { call: payload.call, result, image: modelImageForResult(result, message.chatId) });
    const reply = await this.run(message, payload.continuation.context, onReplyMarkup, onArtifact, steps, payload.continuation.userMessage, pending.run_id, signal);
    finishRun(pending.run_id, signal?.aborted ? "cancelled" : "completed");
    return reply;
  }
}
