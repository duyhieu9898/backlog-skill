"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiProvider = void 0;
const genai_1 = require("@google/genai");
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
class GeminiProvider {
    model;
    client;
    constructor(apiKey, model) {
        this.model = model;
        this.client = new genai_1.GoogleGenAI({ apiKey });
    }
    async complete(input) {
        const request = {
            model: this.model,
            config: {
                systemInstruction: input.system,
                responseMimeType: "application/json",
                responseJsonSchema: provider_1.aiResponseJsonSchema,
            },
            contents: [
                ...input.context.history.map((entry) => ({
                    role: entry.role === "assistant" ? "model" : "user",
                    parts: [{ text: entry.content }],
                })),
                { role: "user", parts: [{ text: userPayload(input) }] },
            ],
        };
        (0, aiInteractions_1.appendRawAiInteraction)({
            traceId: input.traceId,
            provider: "gemini",
            model: this.model,
            direction: "request",
            payload: request,
        });
        const response = await this.client.models.generateContent(request);
        (0, aiInteractions_1.appendRawAiInteraction)({
            traceId: input.traceId,
            provider: "gemini",
            model: this.model,
            direction: "response",
            payload: response,
        });
        const text = response.text || "{}";
        return (0, provider_1.validateAiResponse)(JSON.parse(text));
    }
}
exports.GeminiProvider = GeminiProvider;
