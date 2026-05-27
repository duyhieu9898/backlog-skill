import { loadCommandCatalog, type AgentCommand } from "../commands";
import { listRecentChat, listRecentCommandRuns, listTraceEvents } from "../storage/repositories";
import type { SkillMetadata, SkillRegistry } from "../skills/registry";
import type { StandardMessage } from "../types/messages";

export type HydratedContext = {
  message: StandardMessage;
  recentChat: ReturnType<typeof listRecentChat>;
  skillMetadata: SkillMetadata[];
  selectedSkillContent?: string;
  allowedCommands: AgentCommand[];
  relevantRuns?: ReturnType<typeof listRecentCommandRuns>;
  relevantTraceEvents?: ReturnType<typeof listTraceEvents>;
};

const DEBUG_WORDS = ["lỗi", "bug", "vừa rồi", "lúc nãy", "tại sao", "failed", "error"];
const COMMAND_WORDS = ["chạy", "run", "execute", "checkout", "sync", "verify", "xóa", "delete"];

export class ContextHydrator {
  constructor(private readonly registry: SkillRegistry) {}

  hydrate(message: StandardMessage): HydratedContext {
    const text = message.text.toLowerCase();
    const likelySkill = this.registry.findLikelySkill(text);
    const isDebug = DEBUG_WORDS.some((word) => text.includes(word));
    const isCommand = COMMAND_WORDS.some((word) => text.includes(word));
    const recentRuns = isDebug ? listRecentCommandRuns(message.chatId, 3) : undefined;
    const traceId = this.findTraceId(message.text) || recentRuns?.[0]?.trace_id;

    return {
      message,
      recentChat: listRecentChat(message.chatId, 20),
      skillMetadata: this.registry.listSkills(),
      selectedSkillContent:
        (isCommand || likelySkill) && likelySkill
          ? this.registry.loadSkillContent(likelySkill.slug, 8 * 1024) || undefined
          : undefined,
      allowedCommands: loadCommandCatalog().allow,
      relevantRuns: recentRuns,
      relevantTraceEvents: isDebug && traceId ? listTraceEvents(traceId, 50) : undefined,
    };
  }

  toPromptSections(context: HydratedContext): string {
    const dynamic = JSON.stringify(context, null, 2);
    if (dynamic.length <= 24 * 1024) return dynamic;
    return `${dynamic.slice(0, 24 * 1024)}\n[truncated: dynamic context exceeded 24KB]`;
  }

  private findTraceId(text: string): string | undefined {
    return text.match(/\btr_[a-z0-9]+_[a-f0-9]+\b/)?.[0];
  }
}
