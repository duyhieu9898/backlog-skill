"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContextAssembler = void 0;
const token_estimate_1 = require("./token-estimate");
/**
 * Produces the request-local raw-history tail. Persistence retains every row;
 * this class decides only what a model may see for the current request.
 */
class ContextAssembler {
    budget;
    constructor(budget) {
        this.budget = budget;
    }
    assemble(entries) {
        const kept = [];
        let estimatedTokens = 0;
        let omittedEntries = 0;
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            const entryTokens = (0, token_estimate_1.estimateTokens)(entry);
            if (kept.length > 0 && estimatedTokens + entryTokens > this.budget.recentTailTokens) {
                omittedEntries = index + 1;
                break;
            }
            // A single new message must remain visible even when it exceeds the
            // target; the caller can compact/prune older content before retrying.
            kept.unshift(entry);
            estimatedTokens += entryTokens;
        }
        return { history: kept, estimatedTokens, omittedEntries };
    }
}
exports.ContextAssembler = ContextAssembler;
