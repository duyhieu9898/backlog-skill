"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextHydrator = void 0;
const commands_1 = require("../commands");
const repositories_1 = require("../storage/repositories");
const DEBUG_WORDS = ["lỗi", "bug", "vừa rồi", "lúc nãy", "tại sao", "failed", "error"];
const COMMAND_WORDS = ["chạy", "run", "execute", "checkout", "sync", "verify", "xóa", "delete"];
class ContextHydrator {
    registry;
    constructor(registry) {
        this.registry = registry;
    }
    hydrate(message) {
        const text = message.text.toLowerCase();
        const likelySkill = this.registry.findLikelySkill(text);
        const isDebug = DEBUG_WORDS.some((word) => text.includes(word));
        const isCommand = COMMAND_WORDS.some((word) => text.includes(word));
        const recentRuns = isDebug ? (0, repositories_1.listRecentCommandRuns)(message.chatId, 3) : undefined;
        const traceId = this.findTraceId(message.text) || recentRuns?.[0]?.trace_id;
        return {
            message,
            recentChat: (0, repositories_1.listRecentChat)(message.chatId, 20),
            skillMetadata: this.registry.listSkills(),
            selectedSkillContent: (isCommand || likelySkill) && likelySkill
                ? this.registry.loadSkillContent(likelySkill.slug, 8 * 1024) || undefined
                : undefined,
            allowedCommands: (0, commands_1.loadCommandCatalog)().allow,
            relevantRuns: recentRuns,
            relevantTraceEvents: isDebug && traceId ? (0, repositories_1.listTraceEvents)(traceId, 50) : undefined,
        };
    }
    toPromptSections(context) {
        const dynamic = JSON.stringify(context, null, 2);
        if (dynamic.length <= 24 * 1024)
            return dynamic;
        return `${dynamic.slice(0, 24 * 1024)}\n[truncated: dynamic context exceeded 24KB]`;
    }
    findTraceId(text) {
        return text.match(/\btr_[a-z0-9]+_[a-f0-9]+\b/)?.[0];
    }
}
exports.ContextHydrator = ContextHydrator;
