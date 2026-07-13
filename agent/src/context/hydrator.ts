import { loadCommandCatalog, type AgentCommand } from "../commands";
import { loadAgentConfig } from "../config/app";
import { listRecentChat, listRecentCommandRuns, listTraceEvents } from "../storage/repositories";
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
    .filter((line) => !/^(Executable|Args|Cwd|Timeout|Input|Approval|Gõ:\s*confirm)\s*:/i.test(line.trim()))
    .join("\n")
    .trim();
}

function isToolProtocolMessage(role: string, content: string): boolean {
  const text = content.trim();
  if (role === "user") return /^confirm\b/i.test(text);
  return /^(Tool completed|Tool failed|computer cần xác nhận|```json\s*\{\s*"toolCall"|Không có confirmation nào đang chờ\.)/is.test(text);
}

function runtimeContext(timestamp: Date): AiPromptContext["runtime"] {
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
  return { currentTime, timezone, locale };
}

function pruneHistory(
  history: Array<{ role: "assistant" | "user"; content: string }>
): Array<{ role: "assistant" | "user"; content: string }> {
  return history.map((entry, index) => {
    if (index >= history.length - 3) {
      return entry;
    }
    if (entry.content.length > 1000) {
      return {
        role: entry.role,
        content: `${entry.content.slice(0, 1000)}\n\n[...Nội dung cũ dài ${entry.content.length} ký tự đã được lược bỏ để tiết kiệm token...]`,
      };
    }
    return entry;
  });
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
    // Desktop state is carried by the computer controller and an approved
    // continuation, not by chat transcript. Old previews/frames or a prior
    // task must never steer a fresh request to control a different window.
    const history = includesDesktopIntent
      ? []
      : pruneHistory(
          listRecentChat(message.chatId, 20)
            .filter((entry) => entry.trace_id !== message.traceId)
            .filter((entry) => !isToolProtocolMessage(entry.role, entry.content))
            .map((entry) => ({
              role: entry.role === "assistant" ? "assistant" as const : "user" as const,
              content: redactHistory(entry.content),
            }))
            .filter((entry) => entry.content.length > 0)
        );
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
        runtime: runtimeContext(message.timestamp),
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
