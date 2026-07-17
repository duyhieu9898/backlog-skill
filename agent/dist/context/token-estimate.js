"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokens = estimateTokens;
exports.estimateAiRequestTokens = estimateAiRequestTokens;
/**
 * Deterministic fallback for context budgeting and attribution. Provider usage
 * remains authoritative for billed tokens, but it arrives after a request and
 * cannot protect the request from an oversized prompt.
 */
function estimateTokens(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text)
        return 0;
    // This deliberately rounds up. Vietnamese text, JSON punctuation, and code
    // often tokenize more densely than an English characters/4 rule.
    return Math.ceil(text.length / 3.5);
}
function estimateAiRequestTokens(input) {
    const attribution = {
        system: estimateTokens(input.system),
        history: estimateTokens(input.context.history),
        memory: estimateTokens(input.context.memory),
        runtime: estimateTokens(input.context.runtime),
        skill: estimateTokens(input.context.selectedSkill),
        toolSchemas: estimateTokens(input.tools),
        toolSteps: estimateTokens(input.steps.map(({ image: _image, ...step }) => step)),
        currentMessage: estimateTokens(input.userMessage),
    };
    return {
        ...attribution,
        totalEstimated: Object.values(attribution).reduce((total, value) => total + value, 0),
    };
}
