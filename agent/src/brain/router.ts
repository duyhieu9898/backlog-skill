import crypto from "node:crypto";

import { loadAgentConfig, loadSystemPrompt } from "../config/app";
import { log } from "../logging/logger";
import type { AiProvider, AiResponse, AiToolDefinition, AiToolStep } from "./provider";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiProvider } from "./providers/openai";

export class AiRouter {
  private readonly provider: AiProvider | null;
  private readonly systemPrompt: string;
  private readonly providerName: string;
  private readonly model: string;
  private readonly cacheableHash: string;

  constructor(options: {
    provider?: AiProvider | null;
    providerName?: string;
    model?: string;
    systemPrompt?: string;
  } = {}) {
    const config = loadAgentConfig();
    this.systemPrompt = options.systemPrompt ?? loadSystemPrompt();
    this.providerName = options.providerName ?? config.ai.default;
    const providerConfig = config.ai.providers[config.ai.default];
    this.model = options.model ?? providerConfig?.model ?? "";
    const apiKey = providerConfig ? process.env[providerConfig.apiKeyEnv] : undefined;
    this.cacheableHash = crypto.createHash("sha256").update(this.systemPrompt).digest("hex");

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
    context: string,
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
      });
      return response;
    } catch (error) {
      log.error(traceId, "ai.failed", { error });
      throw error;
    }
  }
}
