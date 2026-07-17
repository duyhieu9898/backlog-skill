import { loadCommandCatalog, type AgentCommand } from "../commands";
import { loadAgentConfig } from "../config/app";
import { getContextCheckpoint, listActiveSessionChat, listRecentCommandRuns, listSessionToolContextBlocks, listTraceEvents, getLastFailedCommandRun, getLastFailedToolEvent } from "../storage/repositories";
import { ContextAssembler } from "./assembler";
import { renderCheckpoint, type ContextCheckpoint } from "./checkpoint";
import { retrieveRelevantDurableMemory } from "./memory";
import type { SkillMetadata, SkillRegistry } from "../skills/registry";
import type { AiPromptContext, AiToolScope } from "../brain/provider";
import type { StandardMessage } from "../types/messages";

export type HydratedContext = {
  message: StandardMessage;
  prompt: AiPromptContext;
  relevantRuns?: ReturnType<typeof listRecentCommandRuns>;
  relevantTraceEvents?: ReturnType<typeof listTraceEvents>;
};

const DEBUG_WORDS = ["lỗi", "bug", "vừa rồi", "lúc nãy", "tại sao", "failed", "error"];
const FILE_WORDS = ["file", "tệp", "thư mục", "folder", "directory", "đọc", "read", "ghi", "write", "patch"];
const DESKTOP_WORDS = ["desktop", "màn hình", "screenshot", "chụp màn hình", "vscode", "vs code", "visual studio code", "app ", "mở app"];
const WEB_WORDS = ["http://", "https://", "website", "trang web", "web "];

function redactHistory(content: string): string {
  return content
    .split("\n")
    .filter((line) => !/^(Executable|Args|Cwd|Timeout|Input|Approval|Gõ:\s*(approve|reject))\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
}

function isToolProtocolMessage(role: string, content: string): boolean {
  const text = content.trim();
  if (role === "user") return /^(approve|reject)\b/i.test(text);
  return /^(Tool completed|Tool failed|computer cần xác nhận|```json\s*\{\s*"toolCall"|Không có confirmation nào đang chờ\.)/is.test(text);
}

function softTrimToolResult(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars / 2);
  const tail = maxChars - head;
  return `${value.slice(0, head)}\n[...old tool result trimmed in working context...]\n${value.slice(-tail)}`;
}

function toolContextBlock(callJson: string, resultJson: string, maxChars: number): string {
  let call = callJson;
  let result = resultJson;
  try { call = JSON.stringify(JSON.parse(callJson)); } catch {}
  try { result = JSON.stringify(JSON.parse(resultJson)); } catch {}
  // Call and result are deliberately one context entry. The assembler may keep
  // or omit the block, but can never split an orphaned tool result from its call.
  return `[TOOL CALL]\n${call}\n[TOOL RESULT]\n${softTrimToolResult(result, maxChars)}`;
}

function runtimeContext(timestamp: Date, lastFailureSummary?: string): AiPromptContext["runtime"] {
  const runtime = loadAgentConfig().runtime;
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

export class ContextHydrator {
  constructor(private readonly registry: SkillRegistry) {}

  hydrate(message: StandardMessage): HydratedContext {
    const text = message.text.toLowerCase();
    const likelySkill = this.registry.findLikelySkill(text);
    const isDebug = DEBUG_WORDS.some((word) => text.includes(word));
    const includesFileIntent = FILE_WORDS.some((word) => text.includes(word));
    const includesDesktopIntent = DESKTOP_WORDS.some((word) => text.includes(word));
    const includesWebIntent = WEB_WORDS.some((word) => text.includes(word));
    const recentRuns = isDebug ? listRecentCommandRuns(message.chatId, 3) : undefined;
    const traceId = this.findTraceId(message.text) || recentRuns?.[0]?.trace_id;
    const toolScope: AiToolScope | undefined = likelySkill
      ? { skillSlug: likelySkill.slug, includeFileTools: false }
      : includesWebIntent
        ? { includeFileTools: false, webOnly: true }
        : includesDesktopIntent
          ? { includeFileTools: false, desktopOnly: true }
      : includesFileIntent
        ? { includeFileTools: true }
        : undefined;

    let lastFailureSummary: string | undefined;
    if (isDebug) {
      const lastCommand = getLastFailedCommandRun();
      const lastTool = getLastFailedToolEvent();
      const parts: string[] = [];
      if (lastCommand) {
        parts.push(`Command "${lastCommand.command_name}" failed (exit: ${lastCommand.exit_code ?? "unknown"}). Error: ${lastCommand.error_message || "none"}. Tail: ${(lastCommand.output_tail || "").slice(-400)}`);
      }
      if (lastTool) {
        let details = lastTool.payload_json;
        try {
          const parsed = JSON.parse(lastTool.payload_json);
          details = parsed.payload ? JSON.stringify(parsed.payload) : lastTool.payload_json;
        } catch {}
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
      : (
          [
            ...listActiveSessionChat(message.chatId)
            .filter((entry) => entry.trace_id !== message.traceId)
            .filter((entry) => !isToolProtocolMessage(entry.role, entry.content))
            .map((entry) => ({
              role: entry.role === "assistant"
                ? "assistant" as const
                : entry.role === "system"
                  ? "system" as const
                  : "user" as const,
              content: redactHistory(entry.content),
              createdAt: entry.created_at,
            }))
            .filter((entry) => entry.content.length > 0),
            ...listSessionToolContextBlocks(message.chatId)
              .filter((entry) => entry.trace_id !== message.traceId)
              .map((entry) => ({
                role: "system" as const,
                content: toolContextBlock(entry.call_json, entry.result_json, loadAgentConfig().context?.toolResultSoftTrimChars || 4_000),
                createdAt: entry.created_at,
              })),
          ]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
            .map(({ role, content }) => ({ role, content }))
        );
    const history = new ContextAssembler({
      recentTailTokens: loadAgentConfig().context?.recentTailTokens || 20_000,
    }).assemble(rawHistory).history;
    const checkpointRow = includesDesktopIntent ? null : getContextCheckpoint(message.chatId);
    if (checkpointRow) {
      try {
        const checkpoint = JSON.parse(checkpointRow.checkpoint_json) as ContextCheckpoint;
        const rendered = renderCheckpoint(checkpoint);
        if (rendered) history.unshift({ role: "system", content: `[SESSION CHECKPOINT]\n${rendered}` });
      } catch {
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
        memory: retrieveRelevantDurableMemory(message.text, loadAgentConfig().context?.retrievedMemoryMaxTokens || 3_000),
        runtime: runtimeContext(message.timestamp, lastFailureSummary),
        selectedSkill,
        toolScope,
      },
      relevantRuns: recentRuns,
      relevantTraceEvents: isDebug && traceId ? listTraceEvents(traceId, 50) : undefined,
    };
  }

  toPromptSections(context: HydratedContext): string {
    const dynamic = JSON.stringify(context.prompt, null, 2);
    if (dynamic.length <= 24 * 1024) return dynamic;
    return `${dynamic.slice(0, 24 * 1024)}\n[truncated: dynamic context exceeded 24KB]`;
  }

  private findTraceId(text: string): string | undefined {
    return text.match(/\btr_[a-z0-9]+_[a-f0-9]+\b/)?.[0];
  }
}
