"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiProvider = void 0;
const genai_1 = require("@google/genai");
const provider_1 = require("../provider");
class GeminiProvider {
    model;
    client;
    constructor(apiKey, model) {
        this.model = model;
        this.client = new genai_1.GoogleGenAI({ apiKey });
    }
    async complete(input) {
        const response = await this.client.models.generateContent({
            model: this.model,
            contents: [
                [
                    input.system,
                    "Return strict JSON with exactly one key: text, clarification, or toolCall.",
                    "toolCall must be {name, arguments} and name must match an available tool.",
                    "Available tools:",
                    JSON.stringify(input.tools),
                    "Previous tool steps:",
                    JSON.stringify(input.steps),
                    "Context:",
                    input.context,
                    "User:",
                    input.userMessage,
                ].join("\n\n"),
            ],
        });
        const text = response.text || "{}";
        return (0, provider_1.validateAiResponse)(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
    }
}
exports.GeminiProvider = GeminiProvider;
