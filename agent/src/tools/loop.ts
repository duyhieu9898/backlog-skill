import { AiRouter } from "../brain/router";
import type { AiPromptContext, AiToolCall, AiToolStep } from "../brain/provider";
import { log } from "../logging/logger";
import {
  deletePendingConfirmation,
  getPendingConfirmation,
  nowIso,
  upsertPendingConfirmation,
} from "../storage/repositories";
import type { StandardMessage } from "../types/messages";
import { ToolExecutor } from "./executor";
import type { ToolResult } from "./contracts";
import { ArtifactStore } from "../artifacts/store";
import { createModelImage } from "./media/image-context";
import fs from "node:fs";
import crypto from "node:crypto";
import { refStore } from "../browser/ref-store";

const MAX_TOOL_STEPS = 8;
const MAX_IDENTICAL_FAILURES = 2;

type PendingAiTool = {
  kind: "ai-tool";
  call: AiToolCall;
  digest: string;
  preview: string;
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

function repeatedFailureMessage(call: AiToolCall, result: ToolResult): string {
  return [
    `Đã dừng sau ${MAX_IDENTICAL_FAILURES} lần lỗi lặp lại cho ${call.name} [${result.code}] để tránh hao token.`,
    result.summary,
    "Hãy thay đổi tham số, chọn tool khác, hoặc gửi yêu cầu rõ hơn trước khi thử lại.",
  ].join("\n");
}

export class AgentToolLoop {
  constructor(
    private readonly ai = new AiRouter(),
    private readonly executor = new ToolExecutor(),
  ) {}

  async run(
    message: StandardMessage,
    context: AiPromptContext,
    onReplyMarkup?: (markup: unknown) => void,
    onArtifact?: (artifactId: string) => void,
    initialSteps: AiToolStep[] = [],
    userMessage = message.text,
  ): Promise<string> {
    const steps: AiToolStep[] = [...initialSteps];
    const failures = new Map<string, number>();
    const tools = this.executor.definitions(context.toolScope);

    for (let index = 0; index < MAX_TOOL_STEPS; index += 1) {
      const response = await this.ai.complete(message.traceId, context, userMessage, tools, steps);
      if (response.clarification) {
        log.info(message.traceId, "ai.clarification.requested", { step: index });
        return response.clarification;
      }
      if (response.text) return response.text;
      if (!response.toolCall) throw new Error("AI response did not contain a valid outcome.");

      log.info(message.traceId, "ai.tool.selected", {
        step: index,
        toolName: response.toolCall.name,
      });
      try {
        const prepared = this.executor.prepare(response.toolCall, message.traceId, tools, message.chatId);
        if (prepared.requiresConfirmation) {
          const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
          const pending: PendingAiTool = {
            kind: "ai-tool",
            call: prepared.call,
            digest: prepared.digest,
            preview: prepared.preview,
            continuation: {
              userMessage,
              context,
              steps: persistentSteps(steps),
            },
          };
          upsertPendingConfirmation({
            chatId: message.chatId,
            traceId: message.traceId,
            commandName: prepared.key,
            payload: pending,
            expiresAt,
          });
          log.info(message.traceId, "ai.tool.confirmation_required", {
            toolName: prepared.call.name,
            confirmationKey: prepared.key,
          });
          onReplyMarkup?.({
            inline_keyboard: [
              [
                {
                  text: `✅ Xác nhận: ${prepared.key}`,
                  callback_data: `confirm ${prepared.key} ${prepared.digest.slice(0, 12)}`,
                },
              ],
            ],
          });
          return [
            `${prepared.key} cần xác nhận trước khi chạy.`,
            prepared.preview,
            `Approval: ${prepared.digest.slice(0, 12)}`,
            `Gõ: confirm ${prepared.key} ${prepared.digest.slice(0, 12)}`,
          ].join("\n");
        }

        const result = await this.executor.execute(prepared, {
          traceId: message.traceId,
          chatId: message.chatId,
        });

        let finalResult = result;
        let finalCall = response.toolCall;

        if (!result.ok && result.code === "STALE_ELEMENT_REF" && response.toolCall.name === "browser") {
          const actionArgs = response.toolCall.arguments as Record<string, any>;
          if (actionArgs?.action === "act") {
            log.info(message.traceId, "ai.tool.stale_ref_retry", {
              toolName: response.toolCall.name,
              ref: actionArgs.request?.ref,
            });

            // 1. Push the failed step first so the trace is complete
            steps.push({
              call: response.toolCall,
              result,
              image: modelImageForResult(result, message.chatId),
            });

            // 2. Schedule and run a new snapshot step
            const profile = actionArgs.profile;
            const targetId = actionArgs.targetId;

            const snapshotCall: AiToolCall = {
              name: "browser",
              arguments: {
                action: "snapshot",
                profile,
                targetId,
              },
            };

            const snapshotPrepared = this.executor.prepare(snapshotCall, message.traceId, tools, message.chatId);
            const snapshotResult = await this.executor.execute(snapshotPrepared, {
              traceId: message.traceId,
              chatId: message.chatId,
            });

            if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(snapshotResult.code) && typeof (snapshotResult.data as { artifactId?: unknown } | undefined)?.artifactId === "string") {
              onArtifact?.((snapshotResult.data as { artifactId: string }).artifactId);
            }

            steps.push({
              call: snapshotCall,
              result: snapshotResult,
              image: modelImageForResult(snapshotResult, message.chatId),
            });

            // 3. Resolve the new reference in the new snapshot
            let newRef: string | undefined = undefined;
            let newSnapshotId: string | undefined = undefined;

            if (snapshotResult.ok && snapshotResult.data) {
              const snapshotData = (snapshotResult.data as any).snapshot;
              newSnapshotId = snapshotData?.snapshotId;
              if (newSnapshotId) {
                const oldSnapshotId = actionArgs.request?.snapshotId;
                const oldRef = actionArgs.request?.ref;
                const descriptor = refStore.getRef(oldSnapshotId, oldRef);
                const newRecord = refStore.getRecord(newSnapshotId);

                if (descriptor && newRecord) {
                  for (const [refId, desc] of newRecord.refs.entries()) {
                    if (desc.role === descriptor.role && desc.name === descriptor.name) {
                      newRef = refId;
                      break;
                    }
                  }
                }
              }
            }

            // 4. Retry the target action exactly once
            const retryCall: AiToolCall = {
              name: "browser",
              arguments: {
                ...response.toolCall.arguments,
                request: {
                  ...actionArgs.request,
                  ref: newRef || actionArgs.request?.ref,
                  snapshotId: newSnapshotId || actionArgs.request?.snapshotId,
                },
              },
            };

            const retryPrepared = this.executor.prepare(retryCall, message.traceId, tools, message.chatId);
            const retryResult = await this.executor.execute(retryPrepared, {
              traceId: message.traceId,
              chatId: message.chatId,
            });

            finalResult = retryResult;
            finalCall = retryCall;

            if (!retryResult.ok) {
              // Retry failed, push to steps and return failure to user immediately
              steps.push({
                call: retryCall,
                result: retryResult,
                image: modelImageForResult(retryResult, message.chatId),
              });
              return `Browser action retry failed: ${retryResult.summary}`;
            }
          }
        }

        if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(finalResult.code) && typeof (finalResult.data as { artifactId?: unknown } | undefined)?.artifactId === "string") {
          onArtifact?.((finalResult.data as { artifactId: string }).artifactId);
        }
        steps.push({ call: finalCall, result: finalResult, image: modelImageForResult(finalResult, message.chatId) });
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
        steps.push({ call: response.toolCall, result });
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

  async consumeConfirmation(
    message: StandardMessage,
    onArtifact?: (artifactId: string) => void,
    onReplyMarkup?: (markup: unknown) => void,
  ): Promise<string | null> {
    const text = message.text.trim().toLowerCase();
    if (!text.startsWith("confirm")) return null;
    const pending = getPendingConfirmation(message.chatId);
    if (!pending) return null;

    let payload: PendingAiTool;
    try {
      payload = JSON.parse(pending.payload_json) as PendingAiTool;
    } catch {
      return null;
    }
    if (payload.kind !== "ai-tool") return null;

    const match = text.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);
    if (!match) return "Confirmation cần tool name và approval token từ preview.";
    if (pending.expires_at <= nowIso()) {
      deletePendingConfirmation(message.chatId);
      return "Confirmation đã hết hạn. Gửi lại yêu cầu để tạo preview mới.";
    }

    let prepared;
    try {
      prepared = this.executor.prepare(payload.call, message.traceId, undefined, message.chatId);
    } catch (error) {
      deletePendingConfirmation(message.chatId);
      return `Confirmation không còn hợp lệ: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (
      prepared.key.toLowerCase() !== match[1] ||
      prepared.digest !== payload.digest ||
      prepared.digest.slice(0, 12) !== match[2]
    ) {
      return "Confirmation không khớp action đã preview.";
    }

    deletePendingConfirmation(message.chatId);
    const result = await this.executor.execute(prepared, {
      traceId: message.traceId,
      chatId: message.chatId,
      confirmationGranted: true,
    });
    if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(result.code) && typeof (result.data as { artifactId?: unknown } | undefined)?.artifactId === "string") {
      onArtifact?.((result.data as { artifactId: string }).artifactId);
    }
    log.info(message.traceId, "ai.tool.confirmed", {
      toolName: prepared.call.name,
      ok: result.ok,
      code: result.code,
    });
    if (!payload.continuation) return formatResult(result);

    const resumedSteps: AiToolStep[] = payload.continuation.steps.map((step) => ({
      ...step,
      image: modelImageForResult(step.result as ToolResult, message.chatId),
    }));
    resumedSteps.push({
      call: payload.call,
      result,
      image: modelImageForResult(result, message.chatId),
    });
    log.info(message.traceId, "ai.tool.continuing_after_confirmation", {
      toolName: prepared.call.name,
      priorSteps: payload.continuation.steps.length,
    });
    return this.run(
      message,
      payload.continuation.context,
      onReplyMarkup,
      onArtifact,
      resumedSteps,
      payload.continuation.userMessage,
    );
  }
}
