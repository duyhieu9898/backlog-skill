"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentToolLoop = void 0;
const router_1 = require("../brain/router");
const logger_1 = require("../logging/logger");
const repositories_1 = require("../storage/repositories");
const executor_1 = require("./executor");
const store_1 = require("../artifacts/store");
const image_context_1 = require("./media/image-context");
const node_fs_1 = __importDefault(require("node:fs"));
const ref_store_1 = require("../browser/ref-store");
const MAX_TOOL_STEPS = 8;
const MAX_IDENTICAL_FAILURES = 2;
function formatResult(result) {
    const data = result.data === undefined ? "" : `\n${JSON.stringify(result.data, null, 2)}`;
    return `${result.ok ? "Tool completed" : "Tool failed"} [${result.code}]\n${result.summary}${data}`;
}
function stableJson(value) {
    if (Array.isArray(value))
        return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        const object = value;
        return `{${Object.keys(object)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
function failureKey(call, result) {
    return `${call.name}:${stableJson(call.arguments)}:${result.code}`;
}
function modelImageForResult(result, chatId) {
    const artifactId = result.data?.artifactId;
    if (typeof artifactId !== "string")
        return undefined;
    try {
        const artifact = new store_1.ArtifactStore().claim(artifactId, chatId);
        return (0, image_context_1.createModelImage)(node_fs_1.default.readFileSync(artifact.local_path), artifact.mime_type);
    }
    catch {
        return undefined;
    }
}
function persistentSteps(steps) {
    // Screenshots are re-read from their artifact when the loop resumes. Never
    // put base64 pixels in the pending-confirmation database row.
    return steps.map(({ call, result }) => ({ call, result }));
}
function repeatedFailureMessage(call, result) {
    return [
        `Đã dừng sau ${MAX_IDENTICAL_FAILURES} lần lỗi lặp lại cho ${call.name} [${result.code}] để tránh hao token.`,
        result.summary,
        "Hãy thay đổi tham số, chọn tool khác, hoặc gửi yêu cầu rõ hơn trước khi thử lại.",
    ].join("\n");
}
class AgentToolLoop {
    ai;
    executor;
    constructor(ai = new router_1.AiRouter(), executor = new executor_1.ToolExecutor()) {
        this.ai = ai;
        this.executor = executor;
    }
    async run(message, context, onReplyMarkup, onArtifact, initialSteps = [], userMessage = message.text) {
        const steps = [...initialSteps];
        const failures = new Map();
        const tools = this.executor.definitions(context.toolScope);
        for (let index = 0; index < MAX_TOOL_STEPS; index += 1) {
            const response = await this.ai.complete(message.traceId, context, userMessage, tools, steps);
            if (response.clarification) {
                logger_1.log.info(message.traceId, "ai.clarification.requested", { step: index });
                return response.clarification;
            }
            if (response.text)
                return response.text;
            if (!response.toolCall)
                throw new Error("AI response did not contain a valid outcome.");
            logger_1.log.info(message.traceId, "ai.tool.selected", {
                step: index,
                toolName: response.toolCall.name,
            });
            try {
                const prepared = this.executor.prepare(response.toolCall, message.traceId, tools, message.chatId);
                if (prepared.requiresConfirmation) {
                    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
                    const pending = {
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
                    (0, repositories_1.upsertPendingConfirmation)({
                        chatId: message.chatId,
                        traceId: message.traceId,
                        commandName: prepared.key,
                        payload: pending,
                        expiresAt,
                    });
                    logger_1.log.info(message.traceId, "ai.tool.confirmation_required", {
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
                    const actionArgs = response.toolCall.arguments;
                    if (actionArgs?.action === "act") {
                        logger_1.log.info(message.traceId, "ai.tool.stale_ref_retry", {
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
                        const snapshotCall = {
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
                        if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(snapshotResult.code) && typeof snapshotResult.data?.artifactId === "string") {
                            onArtifact?.(snapshotResult.data.artifactId);
                        }
                        steps.push({
                            call: snapshotCall,
                            result: snapshotResult,
                            image: modelImageForResult(snapshotResult, message.chatId),
                        });
                        // 3. Resolve the new reference in the new snapshot
                        let newRef = undefined;
                        let newSnapshotId = undefined;
                        if (snapshotResult.ok && snapshotResult.data) {
                            const snapshotData = snapshotResult.data.snapshot;
                            newSnapshotId = snapshotData?.snapshotId;
                            if (newSnapshotId) {
                                const oldSnapshotId = actionArgs.request?.snapshotId;
                                const oldRef = actionArgs.request?.ref;
                                const descriptor = ref_store_1.refStore.getRef(oldSnapshotId, oldRef);
                                const newRecord = ref_store_1.refStore.getRecord(newSnapshotId);
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
                        const retryCall = {
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
                if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(finalResult.code) && typeof finalResult.data?.artifactId === "string") {
                    onArtifact?.(finalResult.data.artifactId);
                }
                steps.push({ call: finalCall, result: finalResult, image: modelImageForResult(finalResult, message.chatId) });
                logger_1.log.info(message.traceId, "ai.tool.completed", {
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
                        logger_1.log.warn(message.traceId, "ai.tool.repeated_failure_stopped", {
                            step: index,
                            toolName: response.toolCall.name,
                            code: result.code,
                            attempts,
                        });
                        return repeatedFailureMessage(response.toolCall, result);
                    }
                }
            }
            catch (error) {
                const result = {
                    ok: false,
                    code: "INVALID_TOOL_CALL",
                    summary: error instanceof Error ? error.message : String(error),
                };
                steps.push({ call: response.toolCall, result });
                logger_1.log.warn(message.traceId, "ai.tool.rejected", {
                    step: index,
                    toolName: response.toolCall.name,
                    reason: result.summary,
                });
                const key = failureKey(response.toolCall, result);
                const attempts = (failures.get(key) || 0) + 1;
                failures.set(key, attempts);
                if (attempts >= MAX_IDENTICAL_FAILURES) {
                    logger_1.log.warn(message.traceId, "ai.tool.repeated_failure_stopped", {
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
    async consumeConfirmation(message, onArtifact, onReplyMarkup) {
        const text = message.text.trim().toLowerCase();
        if (!text.startsWith("confirm"))
            return null;
        const pending = (0, repositories_1.getPendingConfirmation)(message.chatId);
        if (!pending)
            return null;
        let payload;
        try {
            payload = JSON.parse(pending.payload_json);
        }
        catch {
            return null;
        }
        if (payload.kind !== "ai-tool")
            return null;
        const match = text.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);
        if (!match)
            return "Confirmation cần tool name và approval token từ preview.";
        if (pending.expires_at <= (0, repositories_1.nowIso)()) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return "Confirmation đã hết hạn. Gửi lại yêu cầu để tạo preview mới.";
        }
        let prepared;
        try {
            prepared = this.executor.prepare(payload.call, message.traceId, undefined, message.chatId);
        }
        catch (error) {
            (0, repositories_1.deletePendingConfirmation)(message.chatId);
            return `Confirmation không còn hợp lệ: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (prepared.key.toLowerCase() !== match[1] ||
            prepared.digest !== payload.digest ||
            prepared.digest.slice(0, 12) !== match[2]) {
            return "Confirmation không khớp action đã preview.";
        }
        (0, repositories_1.deletePendingConfirmation)(message.chatId);
        const result = await this.executor.execute(prepared, {
            traceId: message.traceId,
            chatId: message.chatId,
            confirmationGranted: true,
        });
        if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(result.code) && typeof result.data?.artifactId === "string") {
            onArtifact?.(result.data.artifactId);
        }
        logger_1.log.info(message.traceId, "ai.tool.confirmed", {
            toolName: prepared.call.name,
            ok: result.ok,
            code: result.code,
        });
        if (!payload.continuation)
            return formatResult(result);
        const resumedSteps = payload.continuation.steps.map((step) => ({
            ...step,
            image: modelImageForResult(step.result, message.chatId),
        }));
        resumedSteps.push({
            call: payload.call,
            result,
            image: modelImageForResult(result, message.chatId),
        });
        logger_1.log.info(message.traceId, "ai.tool.continuing_after_confirmation", {
            toolName: prepared.call.name,
            priorSteps: payload.continuation.steps.length,
        });
        return this.run(message, payload.continuation.context, onReplyMarkup, onArtifact, resumedSteps, payload.continuation.userMessage);
    }
}
exports.AgentToolLoop = AgentToolLoop;
