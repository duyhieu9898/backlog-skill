"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiRouter = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const app_1 = require("../config/app");
const logger_1 = require("../logging/logger");
const gemini_1 = require("./providers/gemini");
const openai_1 = require("./providers/openai");
class AiRouter {
    provider;
    systemPrompt;
    providerName;
    model;
    cacheableHash;
    constructor(options = {}) {
        const config = (0, app_1.loadAgentConfig)();
        this.systemPrompt = options.systemPrompt ?? (0, app_1.loadSystemPrompt)();
        this.providerName = options.providerName ?? config.ai.default;
        const providerConfig = config.ai.providers[config.ai.default];
        this.model = options.model ?? providerConfig?.model ?? "";
        const apiKey = providerConfig ? process.env[providerConfig.apiKeyEnv] : undefined;
        this.cacheableHash = node_crypto_1.default.createHash("sha256").update(this.systemPrompt).digest("hex");
        if ("provider" in options) {
            this.provider = options.provider ?? null;
        }
        else if (!providerConfig || !apiKey) {
            this.provider = null;
        }
        else if (config.ai.default === "openai") {
            this.provider = new openai_1.OpenAiProvider(apiKey, providerConfig.model);
        }
        else {
            this.provider = new gemini_1.GeminiProvider(apiKey, providerConfig.model);
        }
    }
    isConfigured() {
        return Boolean(this.provider);
    }
    async complete(traceId, context, userMessage, tools = [], steps = []) {
        if (!this.provider) {
            return {
                text: "AI provider chưa được cấu hình. Dùng /commands để xem các lệnh chạy trực tiếp.",
            };
        }
        const started = Date.now();
        logger_1.log.info(traceId, "ai.request.created", {
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
            logger_1.log.info(traceId, "ai.response.received", {
                latencyMs: Date.now() - started,
                selectedTool: response.toolCall?.name,
                usage: response.usage,
            });
            return response;
        }
        catch (error) {
            logger_1.log.error(traceId, "ai.failed", { error });
            throw error;
        }
    }
}
exports.AiRouter = AiRouter;
