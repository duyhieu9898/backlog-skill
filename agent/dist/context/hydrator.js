"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextHydrator = void 0;
const app_1 = require("../config/app");
const repositories_1 = require("../storage/repositories");
const assembler_1 = require("./assembler");
const checkpoint_1 = require("./checkpoint");
const memory_1 = require("./memory");
const media_asset_1 = require("./media-asset");
const capability_routing_1 = require("./capability-routing");
const DEBUG_WORDS = ["lỗi", "bug", "vừa rồi", "lúc nãy", "tại sao", "failed", "error"];
const DESKTOP_WORDS = ["desktop", "màn hình", "screenshot", "chụp màn hình", "vscode", "vs code", "visual studio code", "app ", "mở app"];
function redactHistory(content) {
    return content
        .split("\n")
        .filter((line) => !/^(Executable|Args|Cwd|Timeout|Input|Approval|Gõ:\s*(approve|reject))\s*:/i.test(line.trim()))
        .join("\n")
        .trim();
}
function isToolProtocolMessage(role, content) {
    const text = content.trim();
    if (role === "user")
        return /^(approve|reject)\b/i.test(text);
    return /^(Tool completed|Tool failed|computer cần xác nhận|```json\s*\{\s*"toolCall"|Không có confirmation nào đang chờ\.)/is.test(text);
}
function softTrimToolResult(value, maxChars) {
    if (value.length <= maxChars)
        return value;
    const head = Math.floor(maxChars / 2);
    const tail = maxChars - head;
    return `${value.slice(0, head)}\n[...old tool result trimmed in working context...]\n${value.slice(-tail)}`;
}
function toolContextBlock(callJson, resultJson, maxChars, mediaMarker) {
    let call = callJson;
    let result = resultJson;
    try {
        call = JSON.stringify(JSON.parse(callJson));
    }
    catch { }
    try {
        result = JSON.stringify(JSON.parse(resultJson));
    }
    catch { }
    // Call and result are deliberately one context entry. The assembler may keep
    // or omit the block, but can never split an orphaned tool result from its call.
    const body = `[TOOL CALL]\n${call}\n[TOOL RESULT]\n${softTrimToolResult(result, maxChars)}`;
    // US-027 mảng 4: an old tool screenshot is replayed as an informative text
    // marker instead of re-embedded pixels. The marker is metadata-only and never
    // revives the snapshot-bound browser ref that produced the screenshot.
    return mediaMarker ? `${body}\n${mediaMarker}` : body;
}
/** Build replay tool-context blocks, attaching a media marker to any block whose
 *  result references a persisted artifact. The configured budget of most-recent
 *  screenshots hydrate with a full marker; older ones are reduced to minimal. */
function buildToolBlocks(entries, currentTraceId, maxChars, limits) {
    const blocks = entries.filter((entry) => entry.trace_id !== currentTraceId);
    // Resolve asset refs in block order (created_at ASC, id ASC = recency order).
    const refs = [];
    for (let index = 0; index < blocks.length; index += 1) {
        let parsed;
        try {
            parsed = JSON.parse(blocks[index].result_json);
        }
        catch {
            continue;
        }
        const id = (0, media_asset_1.extractArtifactId)(parsed);
        if (!id)
            continue;
        const meta = (0, repositories_1.getArtifactMetadata)(id);
        if (!meta)
            continue;
        refs.push({
            index,
            ref: {
                assetId: meta.id,
                mimeType: meta.mime_type,
                sha256: meta.sha256,
                byteSize: meta.byte_size,
                ...(meta.width !== null ? { width: meta.width } : {}),
                ...(meta.height !== null ? { height: meta.height } : {}),
                ...(meta.observation_summary ? { observationSummary: meta.observation_summary } : {}),
            },
        });
    }
    // The budget applies to artifact-bearing blocks by recency.
    const detailByPosition = (0, media_asset_1.selectAssetsForReplay)(refs.map((entry) => entry.ref), limits);
    const markerByIndex = new Map();
    refs.forEach((entry, position) => {
        markerByIndex.set(entry.index, (0, media_asset_1.renderObservationMarker)((0, media_asset_1.observationMarkerFromRef)(entry.ref, detailByPosition[position])));
    });
    return blocks.map((entry, index) => ({
        role: "system",
        content: toolContextBlock(entry.call_json, entry.result_json, maxChars, markerByIndex.get(index)),
        createdAt: entry.created_at,
    }));
}
function runtimeContext(timestamp, lastFailureSummary) {
    const runtime = (0, app_1.loadAgentConfig)().runtime;
    const timezone = runtime?.timezone || "Asia/Ho_Chi_Minh";
    const locale = runtime?.locale || "vi-VN";
    const currentTime = new Intl.DateTimeFormat("sv-SE", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).format(timestamp).replace(" ", "T");
    return {
        currentTime,
        timezone,
        locale,
        ...(lastFailureSummary !== undefined ? { lastFailureSummary } : {}),
    };
}
class ContextHydrator {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    hydrate(message) {
        const text = message.text.toLowerCase();
        const likelySkill = this.registry.findLikelySkill(text);
        const isDebug = DEBUG_WORDS.some((word) => text.includes(word));
        const includesDesktopIntent = DESKTOP_WORDS.some((word) => text.includes(word));
        const recentRuns = isDebug ? (0, repositories_1.listRecentCommandRuns)(message.chatId, 3) : undefined;
        const traceId = this.findTraceId(message.text) || recentRuns?.[0]?.trace_id;
        const scopeKey = `active_capability_scope:${message.chatId}:${(0, repositories_1.getActiveSessionId)(message.chatId)}`;
        const resolvedScope = (0, capability_routing_1.resolveCapabilityRoute)({
            text: message.text,
            traceId: message.traceId,
            activeLease: (0, repositories_1.getJsonState)("runtime_state", scopeKey),
            skillSlug: likelySkill?.slug,
        });
        (0, repositories_1.setJsonState)("runtime_state", scopeKey, resolvedScope.lease);
        let lastFailureSummary;
        if (isDebug) {
            const lastCommand = (0, repositories_1.getLastFailedCommandRun)();
            const lastTool = (0, repositories_1.getLastFailedToolEvent)();
            const parts = [];
            if (lastCommand) {
                parts.push(`Command "${lastCommand.command_name}" failed (exit: ${lastCommand.exit_code ?? "unknown"}). Error: ${lastCommand.error_message || "none"}. Tail: ${(lastCommand.output_tail || "").slice(-400)}`);
            }
            if (lastTool) {
                let details = lastTool.payload_json;
                try {
                    const parsed = JSON.parse(lastTool.payload_json);
                    details = parsed.payload ? JSON.stringify(parsed.payload) : lastTool.payload_json;
                }
                catch { }
                parts.push(`Tool "${lastTool.event}" failed. Details: ${details.slice(0, 400)}`);
            }
            if (parts.length > 0) {
                lastFailureSummary = parts.join(" | ");
            }
        }
        // Desktop state is carried by the computer controller and an approved
        // continuation, not by chat transcript. Old previews/frames or a prior
        // task must never steer a fresh request to control a different window.
        const rawHistory = includesDesktopIntent
            ? []
            : ([
                ...(0, repositories_1.listActiveSessionChat)(message.chatId)
                    .filter((entry) => entry.trace_id !== message.traceId)
                    .filter((entry) => !isToolProtocolMessage(entry.role, entry.content))
                    .map((entry) => ({
                    role: entry.role === "assistant"
                        ? "assistant"
                        : entry.role === "system"
                            ? "system"
                            : "user",
                    content: redactHistory(entry.content),
                    createdAt: entry.created_at,
                }))
                    .filter((entry) => entry.content.length > 0),
                ...buildToolBlocks((0, repositories_1.listSessionToolContextBlocks)(message.chatId), message.traceId, (0, app_1.loadAgentConfig)().context?.toolResultSoftTrimChars || 4_000, (0, media_asset_1.defaultReplayLimits)((0, app_1.loadAgentConfig)().context?.mediaReplay)),
            ]
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
                .map(({ role, content }) => ({ role, content })));
        const history = new assembler_1.ContextAssembler({
            recentTailTokens: (0, app_1.loadAgentConfig)().context?.recentTailTokens || 20_000,
        }).assemble(rawHistory).history;
        const checkpointRow = includesDesktopIntent ? null : (0, repositories_1.getContextCheckpoint)(message.chatId);
        if (checkpointRow) {
            try {
                const checkpoint = JSON.parse(checkpointRow.checkpoint_json);
                const rendered = (0, checkpoint_1.renderCheckpoint)(checkpoint);
                if (rendered)
                    history.unshift({ role: "system", content: `[SESSION CHECKPOINT]\n${rendered}` });
            }
            catch {
                // A corrupt checkpoint must not stop a live conversation. It remains
                // durable evidence for diagnosis and a later repair.
            }
        }
        const selectedSkill = likelySkill
            ? {
                slug: likelySkill.slug,
                name: likelySkill.name,
                description: likelySkill.description,
                instructions: this.registry.loadSkillContent(likelySkill.slug, 8 * 1024) || undefined,
            }
            : undefined;
        return {
            message,
            prompt: {
                history,
                memory: (0, memory_1.retrieveRelevantDurableMemory)(message.text, (0, app_1.loadAgentConfig)().context?.retrievedMemoryMaxTokens || 3_000),
                runtime: runtimeContext(message.timestamp, lastFailureSummary),
                selectedSkill,
                capabilityRoute: resolvedScope.route,
            },
            relevantRuns: recentRuns,
            relevantTraceEvents: isDebug && traceId ? (0, repositories_1.listTraceEvents)(traceId, 50) : undefined,
        };
    }
    toPromptSections(context) {
        const dynamic = JSON.stringify(context.prompt, null, 2);
        if (dynamic.length <= 24 * 1024)
            return dynamic;
        return `${dynamic.slice(0, 24 * 1024)}\n[truncated: dynamic context exceeded 24KB]`;
    }
    findTraceId(text) {
        return text.match(/\btr_[a-z0-9]+_[a-f0-9]+\b/)?.[0];
    }
}
exports.ContextHydrator = ContextHydrator;
