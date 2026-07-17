import type { AiChatTurn } from "../brain/provider";
import { estimateTokens } from "./token-estimate";

export type ContextBudget = {
  recentTailTokens: number;
};

export type ContextAssembly = {
  history: AiChatTurn[];
  estimatedTokens: number;
  omittedEntries: number;
};

/**
 * Produces the request-local raw-history tail. Persistence retains every row;
 * this class decides only what a model may see for the current request.
 */
export class ContextAssembler {
  constructor(private readonly budget: ContextBudget) {}

  assemble(entries: AiChatTurn[]): ContextAssembly {
    const kept: AiChatTurn[] = [];
    let estimatedTokens = 0;
    let omittedEntries = 0;

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const entryTokens = estimateTokens(entry);
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
