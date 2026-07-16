"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentToolLoop = void 0;
const router_1 = require("../brain/router");
const logger_1 = require("../logging/logger");
const gateway_1 = require("./gateway");
const approvalService_1 = require("../security/approvalService");
const repositories_1 = require("../storage/repositories");
const store_1 = require("../artifacts/store");
const image_context_1 = require("./media/image-context");
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = __importDefault(require("node:crypto"));
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
function appendStep(runId, steps, step) {
    steps.push(step);
    (0, repositories_1.appendRunStep)({ runId, toolName: step.call.name, call: step.call, result: step.result });
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
    gateway;
    approvals = new approvalService_1.ApprovalService();
    constructor(ai = new router_1.AiRouter(), gateway = new gateway_1.ToolGateway()) {
        this.ai = ai;
        this.gateway = gateway;
    }
    /** Prepare, then authorize with grant coverage derived from the action profile. */
    prepareAuthorized(call, message, runId, sessionId, toolCallId, tools, userMessage, approvalGranted = false) {
        const raw = this.gateway.prepareRaw(call, message.traceId, tools, message.chatId);
        const covered = raw.profile
            ? this.approvals.covers({ principalId: message.userId, runId, sessionId, profile: raw.profile })
            : false;
        return this.gateway.authorizePrepared({
            ...raw,
            userIntent: userMessage,
            approvalGranted: covered || approvalGranted,
            audit: { traceId: message.traceId, sessionId, runId, toolCallId },
        }, message.chatId);
    }
    async run(message, context, onReplyMarkup, onArtifact, initialSteps = [], userMessage = message.text, runId = message.traceId, signal) {
        const steps = [...initialSteps];
        const failures = new Map();
        const tools = this.gateway.definitions(context.toolScope);
        const sessionId = (0, repositories_1.getActiveSessionId)(message.chatId);
        for (let index = 0; index < MAX_TOOL_STEPS; index += 1) {
            if (signal?.aborted)
                return "Run cancelled.";
            const response = await this.ai.complete(message.traceId, context, userMessage, tools, steps);
            if (response.clarification) {
                logger_1.log.info(message.traceId, "ai.clarification.requested", { step: index });
                return response.clarification;
            }
            if (response.text)
                return response.text;
            if (!response.toolCall)
                throw new Error("AI response did not contain a valid outcome.");
            const toolCallId = `tc_${node_crypto_1.default.randomUUID()}`;
            logger_1.log.info(message.traceId, "ai.tool.selected", {
                step: index,
                toolName: response.toolCall.name,
            });
            try {
                const prepared = this.prepareAuthorized(response.toolCall, message, runId, sessionId, toolCallId, tools, userMessage);
                if (prepared.requiresConfirmation) {
                    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
                    const pending = {
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
                    logger_1.log.info(message.traceId, "ai.tool.confirmation_required", {
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
                if (!result.ok && result.code === "STALE_ELEMENT_REF" && response.toolCall.name === "browser") {
                    const actionArgs = response.toolCall.arguments;
                    if (actionArgs?.action === "act") {
                        logger_1.log.info(message.traceId, "ai.tool.stale_ref_retry", {
                            toolName: response.toolCall.name,
                            ref: actionArgs.request?.ref,
                        });
                        // 1. Push the failed step first so the trace is complete
                        appendStep(runId, steps, {
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
                        const snapshotPrepared = this.prepareAuthorized(snapshotCall, message, runId, sessionId, `tc_${node_crypto_1.default.randomUUID()}`, tools, userMessage);
                        const snapshotResult = await this.gateway.execute(snapshotPrepared, {
                            traceId: message.traceId,
                            chatId: message.chatId,
                            signal,
                        });
                        if (["DESKTOP_CAPTURED", "COMPUTER_SCREENSHOT", "COMPUTER_ACTION_COMPLETED", "COMPUTER_LAUNCHED", "WEB_CAPTURED", "BROWSER_SCREENSHOT", "BROWSER_ACTION_COMPLETED"].includes(snapshotResult.code) && typeof snapshotResult.data?.artifactId === "string") {
                            onArtifact?.(snapshotResult.data.artifactId);
                        }
                        appendStep(runId, steps, {
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
                        const retryPrepared = this.prepareAuthorized(retryCall, message, runId, sessionId, `tc_${node_crypto_1.default.randomUUID()}`, tools, userMessage);
                        const retryResult = await this.gateway.execute(retryPrepared, {
                            traceId: message.traceId,
                            chatId: message.chatId,
                            signal,
                        });
                        finalResult = retryResult;
                        finalCall = retryCall;
                        if (!retryResult.ok) {
                            // Retry failed, push to steps and return failure to user immediately
                            appendStep(runId, steps, {
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
                appendStep(runId, steps, { call: finalCall, result: finalResult, image: modelImageForResult(finalResult, message.chatId) });
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
                appendStep(runId, steps, { call: response.toolCall, result });
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
    async consumeScopedApproval(message, onArtifact, onReplyMarkup) {
        const match = message.text.trim().toLowerCase().match(/^(approve|reject)\s+([a-f0-9]{8})$/);
        if (!match)
            return null;
        const candidate = this.approvals.get(match[2], message.userId, message.chatId);
        if (!candidate)
            return null;
        let payload;
        try {
            payload = JSON.parse(candidate.payload_json);
        }
        catch {
            return null;
        }
        if (payload.kind !== "ai-tool")
            return null;
        let prepared;
        try {
            const resumeSessionId = (0, repositories_1.getActiveSessionId)(message.chatId);
            const resumeToolCallId = payload.toolCallId ?? `tc_${node_crypto_1.default.randomUUID()}`;
            prepared = this.prepareAuthorized(payload.call, message, candidate.run_id, resumeSessionId, resumeToolCallId, undefined, payload.continuation?.userMessage, match[1] === "approve");
        }
        catch {
            return "Approval không còn hợp lệ.";
        }
        const pending = this.approvals.resolve({ shortId: match[2], principalId: message.userId, chatId: message.chatId, actionDigest: prepared.digest, approve: match[1] === "approve" });
        if (!pending)
            return "Approval không tồn tại, đã hết hạn, hoặc action đã thay đổi.";
        if (match[1] === "reject")
            return "Đã từ chối action đang chờ.";
        const result = await this.gateway.execute(prepared, { traceId: message.traceId, chatId: message.chatId, confirmationGranted: true });
        if (typeof result.data?.artifactId === "string")
            onArtifact?.(result.data.artifactId);
        if (!payload.continuation) {
            (0, repositories_1.finishRun)(pending.run_id, result.ok ? "completed" : "failed", result.ok ? undefined : result.summary);
            return formatResult(result);
        }
        const steps = payload.continuation.steps.map((step) => ({ ...step, image: modelImageForResult(step.result, message.chatId) }));
        appendStep(pending.run_id, steps, { call: payload.call, result, image: modelImageForResult(result, message.chatId) });
        const reply = await this.run(message, payload.continuation.context, onReplyMarkup, onArtifact, steps, payload.continuation.userMessage, pending.run_id);
        (0, repositories_1.finishRun)(pending.run_id, "completed");
        return reply;
    }
}
exports.AgentToolLoop = AgentToolLoop;
