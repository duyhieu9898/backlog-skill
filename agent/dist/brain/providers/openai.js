"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAiProvider = void 0;
const openai_1 = __importDefault(require("openai"));
const aiInteractions_1 = require("../../logging/aiInteractions");
const provider_1 = require("../provider");
function userPayload(input) {
    return JSON.stringify({
        runtime: input.context.runtime,
        selectedSkill: input.context.selectedSkill,
        availableTools: input.tools,
        previousToolSteps: input.steps,
        userMessage: input.userMessage,
    });
}
class OpenAiProvider {
    model;
    client;
    constructor(apiKey, model) {
        this.model = model;
        this.client = new openai_1.default({ apiKey });
    }
    async complete(input) {
        const request = {
            model: this.model,
            messages: [
                { role: "system", content: input.system },
                ...input.context.history.map((entry) => ({
                    role: entry.role === "assistant" ? "assistant" : entry.role === "system" ? "system" : "user",
                    content: entry.content,
                })),
                {
                    role: "user",
                    content: userPayload(input),
                },
            ],
            response_format: { type: "json_object" },
        };
        (0, aiInteractions_1.appendRawAiInteraction)({
            traceId: input.traceId,
            provider: "openai",
            model: this.model,
            direction: "request",
            payload: request,
        });
        const response = await this.client.chat.completions.create(request);
        (0, aiInteractions_1.appendRawAiInteraction)({
            traceId: input.traceId,
            provider: "openai",
            model: this.model,
            direction: "response",
            payload: response,
        });
        const content = response.choices[0]?.message.content || "{}";
        return { ...(0, provider_1.validateAiResponse)(JSON.parse(content)), usage: response.usage };
    }
}
exports.OpenAiProvider = OpenAiProvider;
