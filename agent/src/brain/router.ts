import crypto from "node:crypto";

import { loadAgentConfig, loadSystemPrompt } from "../config/app";
import { log } from "../logging/logger";
import type { AiProvider, AiResponse } from "./provider";
import { GeminiProvider } from "./providers/gemini";
import { OpenAiProvider } from "./providers/openai";

export class AiRouter {
  private readonly provider: AiProvider | null;
  private readonly systemPrompt: string;
  private readonly providerName: string;
  private readonly model: string;
  private readonly cacheableHash: string;

  constructor() {
    const config = loadAgentConfig();
    this.systemPrompt = loadSystemPrompt();
    this.providerName = config.ai.default;
    const providerConfig = config.ai.providers[config.ai.default];
    this.model = providerConfig?.model || "";
    const apiKey = providerConfig ? process.env[providerConfig.apiKeyEnv] : undefined;
    this.cacheableHash = crypto.createHash("sha256").update(this.systemPrompt).digest("hex");

    if (!providerConfig || !apiKey) {
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

  async complete(traceId: string, context: string, userMessage: string): Promise<AiResponse> {
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
      });
      log.info(traceId, "ai.response.received", {
        latencyMs: Date.now() - started,
        selectedCommand: response.commandName,
        hasRawCommand: Boolean(response.rawCommand),
        usage: response.usage,
      });
      return response;
    } catch (error) {
      log.error(traceId, "ai.failed", { error });
      throw error;
    }
  }
}
