import type { AiRequest, NormalizedUsage } from "../brain/provider";

/**
 * Deterministic fallback for context budgeting and attribution. Provider usage
 * remains authoritative for billed tokens, but it arrives after a request and
 * cannot protect the request from an oversized prompt.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 0;
  // This deliberately rounds up. Vietnamese text, JSON punctuation, and code
  // often tokenize more densely than an English characters/4 rule.
  return Math.ceil(text.length / 3.5);
}

export type PromptTokenAttribution = {
  system: number;
  history: number;
  memory: number;
  runtime: number;
  skill: number;
  toolSchemas: number;
  toolSteps: number;
  currentMessage: number;
  totalEstimated: number;
};

export function estimateAiRequestTokens(input: AiRequest): PromptTokenAttribution {
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
export function normalizeUsage(providerUsage: unknown, estimate: PromptTokenAttribution, input: AiRequest): NormalizedUsage {
  const raw = providerUsage && typeof providerUsage === "object" ? providerUsage as Record<string, unknown> : {};
  const number = (...keys: string[]) => {
    for (const key of keys) if (typeof raw[key] === "number") return raw[key] as number;
    return undefined;
  };
  const modality = (value: unknown): Record<string, number> | undefined => {
    if (!Array.isArray(value)) return undefined;
    const result: Record<string, number> = {};
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      if (typeof row.modality === "string" && typeof row.tokenCount === "number") result[row.modality] = row.tokenCount;
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
  const rawSummary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (tokenRelevantKeys.has(key)) rawSummary[key] = value;
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
