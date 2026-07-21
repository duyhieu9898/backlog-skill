"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiRouter = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const app_1 = require("../config/app");
const aiInteractions_1 = require("../logging/aiInteractions");
const logger_1 = require("../logging/logger");
const token_estimate_1 = require("../context/token-estimate");
const gemini_1 = require("./providers/gemini");
const openai_1 = require("./providers/openai");
const PROVIDER_RETRY_DELAYS_MS = [500, 1000, 2000];
function isTransientProviderError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(message);
}
class AiRouter {
    provider;
    systemPrompt;
    customSystemPrompt;
    providerName;
    model;
    cacheableHash;
    sleep;
    constructor(options = {}) {
        const config = (0, app_1.loadAgentConfig)();
        this.customSystemPrompt = options.systemPrompt;
        this.systemPrompt = options.systemPrompt ?? (0, app_1.loadSystemPrompt)();
        this.providerName = options.providerName ?? config.ai.default;
        const providerConfig = config.ai.providers[config.ai.default];
        this.model = options.model ?? providerConfig?.model ?? "";
        const apiKey = providerConfig ? process.env[providerConfig.apiKeyEnv] : undefined;
        this.cacheableHash = node_crypto_1.default.createHash("sha256").update(this.systemPrompt).digest("hex");
        this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
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
        const activePrompt = this.customSystemPrompt !== undefined ? this.customSystemPrompt : (0, app_1.loadSystemPrompt)();
        const activeHash = node_crypto_1.default.createHash("sha256").update(activePrompt).digest("hex");
        const effectiveContext = this.fitContextToBudget(activePrompt, context, userMessage, tools, steps);
        const requestTokenEstimate = (0, token_estimate_1.estimateAiRequestTokens)({
            traceId,
            system: activePrompt,
            context: effectiveContext,
            userMessage,
            tools,
            steps,
        });
        logger_1.log.info(traceId, "ai.request.created", {
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
                logger_1.log.info(traceId, "ai.response.received", {
                    latencyMs: Date.now() - started,
                    selectedTool: response.toolCall?.name,
                    usage: (0, token_estimate_1.normalizeUsage)(response.usage, requestTokenEstimate, {
                        traceId, system: activePrompt, context: effectiveContext, userMessage, tools, steps,
                    }),
                    attempt: attempt + 1,
                });
                return response;
            }
            catch (error) {
                (0, aiInteractions_1.appendRawAiInteraction)({
                    traceId,
                    provider: this.providerName,
                    model: this.model,
                    direction: "error",
                    payload: error,
                });
                const retryDelay = PROVIDER_RETRY_DELAYS_MS[attempt];
                if (retryDelay === undefined || !isTransientProviderError(error)) {
                    logger_1.log.error(traceId, "ai.failed", { error, attempt: attempt + 1 });
                    throw error;
                }
                logger_1.log.warn(traceId, "ai.retry.scheduled", {
                    attempt: attempt + 1,
                    retryDelayMs: retryDelay,
                    error: error instanceof Error ? error.message : String(error),
                });
                await this.sleep(retryDelay);
            }
        }
        throw new Error("AI provider retry loop ended unexpectedly.");
    }
    fitContextToBudget(system, context, userMessage, tools, steps) {
        const policy = (0, app_1.loadAgentConfig)().context;
        const limit = (policy?.maxContextTokens || 128_000) - (policy?.reserveTokens || 20_000);
        const history = Array.isArray(context.history) ? [...context.history] : [];
        const memory = Array.isArray(context.memory) ? [...context.memory] : [];
        const estimate = () => (0, token_estimate_1.estimateAiRequestTokens)({ traceId: "budget", system, context: { ...context, history, memory }, userMessage, tools, steps }).totalEstimated;
        while (estimate() > limit && history.length > 0) {
            // A checkpoint is durable state, so retain it and remove the oldest raw
            // block instead. Tool call/result pairs are represented as one block.
            const removable = history.findIndex((entry) => !entry.content.startsWith("[SESSION CHECKPOINT]"));
            if (removable < 0)
                break;
            history.splice(removable, 1);
        }
        while (estimate() > limit && memory.length > 0)
            memory.pop();
        return { ...context, history, memory };
    }
}
exports.AiRouter = AiRouter;
