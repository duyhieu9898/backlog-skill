import crypto from "node:crypto";

import { loadAgentConfig, loadSystemPrompt } from "../config/app";
import { appendRawAiInteraction } from "../logging/aiInteractions";
import { log } from "../logging/logger";
import { estimateAiRequestTokens } from "../context/token-estimate";
import type { AiPromptContext, AiProvider, AiResponse, AiToolDefinition, AiToolStep } from "./provider";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiProvider } from "./providers/openai";

const PROVIDER_RETRY_DELAYS_MS = [500, 1000, 2000];

function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
    message,
  );
}

export class AiRouter {
  private readonly provider: AiProvider | null;
  private readonly systemPrompt: string;
  private readonly customSystemPrompt?: string;
  private readonly providerName: string;
  private readonly model: string;
  private readonly cacheableHash: string;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: {
    provider?: AiProvider | null;
    providerName?: string;
    model?: string;
    systemPrompt?: string;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {}) {
    const config = loadAgentConfig();
    this.customSystemPrompt = options.systemPrompt;
    this.systemPrompt = options.systemPrompt ?? loadSystemPrompt();
    this.providerName = options.providerName ?? config.ai.default;
    const providerConfig = config.ai.providers[config.ai.default];
    this.model = options.model ?? providerConfig?.model ?? "";
    const apiKey = providerConfig ? process.env[providerConfig.apiKeyEnv] : undefined;
    this.cacheableHash = crypto.createHash("sha256").update(this.systemPrompt).digest("hex");
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

    if ("provider" in options) {
      this.provider = options.provider ?? null;
    } else if (!providerConfig || !apiKey) {
      this.provider = null;
    } else if (config.ai.default === "openai") {
      this.provider = new OpenAiProvider(apiKey, providerConfig.model);
    } else {
      this.provider = new GeminiProvider(apiKey, providerConfig.model);
    }
  }

  isConfigured(): boolean {
    return Boolean(this.provider);
  }

  async complete(
    traceId: string,
    context: AiPromptContext,
    userMessage: string,
    tools: AiToolDefinition[] = [],
    steps: AiToolStep[] = [],
  ): Promise<AiResponse> {
    if (!this.provider) {
      return {
        text: "AI provider chưa được cấu hình. Dùng /commands để xem các lệnh chạy trực tiếp.",
      };
    }

    const started = Date.now();
    const activePrompt = this.customSystemPrompt !== undefined ? this.customSystemPrompt : loadSystemPrompt();
    const activeHash = crypto.createHash("sha256").update(activePrompt).digest("hex");
    const effectiveContext = this.fitContextToBudget(activePrompt, context, userMessage, tools, steps);

    const requestTokenEstimate = estimateAiRequestTokens({
      traceId,
      system: activePrompt,
      context: effectiveContext,
      userMessage,
      tools,
      steps,
    });
    log.info(traceId, "ai.request.created", {
      provider: this.providerName,
      model: this.model,
      cacheablePrefixHash: activeHash,
      tokenAttribution: requestTokenEstimate,
    });
    for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.provider.complete({
          traceId,
          system: activePrompt,
          context: effectiveContext,
          userMessage,
          tools,
          steps,
        });
        log.info(traceId, "ai.response.received", {
          latencyMs: Date.now() - started,
          selectedTool: response.toolCall?.name,
          usage: response.usage,
          attempt: attempt + 1,
        });
        return response;
      } catch (error) {
        appendRawAiInteraction({
          traceId,
          provider: this.providerName,
          model: this.model,
          direction: "error",
          payload: error,
        });
        const retryDelay = PROVIDER_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !isTransientProviderError(error)) {
          log.error(traceId, "ai.failed", { error, attempt: attempt + 1 });
          throw error;
        }
        log.warn(traceId, "ai.retry.scheduled", {
          attempt: attempt + 1,
          retryDelayMs: retryDelay,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.sleep(retryDelay);
      }
    }

    throw new Error("AI provider retry loop ended unexpectedly.");
  }

  private fitContextToBudget(
    system: string,
    context: AiPromptContext,
    userMessage: string,
    tools: AiToolDefinition[],
    steps: AiToolStep[],
  ): AiPromptContext {
    const policy = loadAgentConfig().context;
    const limit = (policy?.maxContextTokens || 128_000) - (policy?.reserveTokens || 20_000);
    const history = Array.isArray(context.history) ? [...context.history] : [];
    const memory = Array.isArray(context.memory) ? [...context.memory] : [];
    const estimate = () => estimateAiRequestTokens({ traceId: "budget", system, context: { ...context, history, memory }, userMessage, tools, steps }).totalEstimated;
    while (estimate() > limit && history.length > 0) {
      // A checkpoint is durable state, so retain it and remove the oldest raw
      // block instead. Tool call/result pairs are represented as one block.
      const removable = history.findIndex((entry) => !entry.content.startsWith("[SESSION CHECKPOINT]"));
      if (removable < 0) break;
      history.splice(removable, 1);
    }
    while (estimate() > limit && memory.length > 0) memory.pop();
    return { ...context, history, memory };
  }
}
