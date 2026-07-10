import crypto from "node:crypto";

import { loadAgentConfig, loadSystemPrompt } from "../config/app";
import { log } from "../logging/logger";
import type { AiPromptContext, AiProvider, AiResponse, AiToolDefinition, AiToolStep } from "./provider";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiProvider } from "./providers/openai";

const PROVIDER_RETRY_DELAYS_MS = [250, 500];

function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
    message,
  );
}

export class AiRouter {
  private readonly provider: AiProvider | null;
  private readonly systemPrompt: string;
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
    log.info(traceId, "ai.request.created", {
      provider: this.providerName,
      model: this.model,
      cacheablePrefixHash: this.cacheableHash,
    });
    for (let attempt = 0; attempt <= PROVIDER_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const response = await this.provider.complete({
          system: this.systemPrompt,
          context,
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
}
