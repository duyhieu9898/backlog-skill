"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.estimateTokens = estimateTokens;
exports.estimateAiRequestTokens = estimateAiRequestTokens;
exports.normalizeUsage = normalizeUsage;
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
        toolSchemas: input.tools.length ? estimateTokens(input.tools) : 0,
        toolSteps: estimateTokens(input.steps.map(({ image: _image, ...step }) => step)),
        currentMessage: estimateTokens(input.userMessage),
    };
    return {
        ...attribution,
        totalEstimated: Object.values(attribution).reduce((total, value) => total + value, 0),
    };
}
/** Keep deterministic local estimates distinct from provider billing metadata. */
function normalizeUsage(providerUsage, estimate, input) {
    const raw = providerUsage && typeof providerUsage === "object" ? providerUsage : {};
    const number = (...keys) => {
        for (const key of keys)
            if (typeof raw[key] === "number")
                return raw[key];
        return undefined;
    };
    const modality = (value) => {
        if (!Array.isArray(value))
            return undefined;
        const result = {};
        for (const item of value) {
            if (!item || typeof item !== "object")
                continue;
            const row = item;
            if (typeof row.modality === "string" && typeof row.tokenCount === "number")
                result[row.modality] = row.tokenCount;
        }
        return Object.keys(result).length ? result : undefined;
    };
    const inputByModality = modality(raw.promptTokensDetails);
    const cachedByModality = modality(raw.cacheTokensDetails);
    // Slim raw summary: keep only token-relevant fields. The full provider
    // payload (with contents/inlineData) is retained by appendRawAiInteraction;
    // duplicating it into every ai.response.received log line is redundant.
    const tokenRelevantKeys = new Set([
        "promptTokenCount", "candidatesTokenCount", "cachedContentTokenCount", "totalTokenCount",
        "promptTokensDetails", "cacheTokensDetails", "cachedContentTokensDetails",
        "prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "input_tokens", "output_tokens",
        "model",
    ]);
    const rawSummary = {};
    for (const [key, value] of Object.entries(raw)) {
        if (tokenRelevantKeys.has(key))
            rawSummary[key] = value;
    }
    // INVARIANT (US-027): clientEstimated.imageTokens is computed independently
    // and is NEVER subtracted from inputTokensTotal. Provider totals are kept
    // verbatim; media cost must not be reverse-engineered into observed text.
    return {
        providerReported: {
            inputTokensTotal: number("promptTokenCount", "prompt_tokens", "input_tokens"),
            outputTokens: number("candidatesTokenCount", "completion_tokens", "output_tokens"),
            cacheReadTokens: number("cachedContentTokenCount", "cached_tokens"),
            inputByModality,
            cachedByModality,
            observedModalities: inputByModality ? Object.keys(inputByModality) : undefined,
            rawSummary,
        },
        clientEstimated: {
            textTokens: estimate.system + estimate.history + estimate.memory + estimate.runtime + estimate.skill + estimate.currentMessage,
            toolSchemaTokens: estimate.toolSchemas,
            toolResultTokens: estimate.toolSteps,
            imageTokens: input.steps.reduce((total, step) => total + (step.image ? Math.ceil(step.image.byteSize / 768) : 0), 0),
            estimator: { name: "chars-per-token-plus-image-bytes", version: "1", confidence: "low" },
        },
    };
}
