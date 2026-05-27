"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiProvider = void 0;
const genai_1 = require("@google/genai");
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
                    "Return strict JSON with optional keys: text, commandName, rawCommand, clarification.",
                    "Context:",
                    input.context,
                    "User:",
                    input.userMessage,
                ].join("\n\n"),
            ],
        });
        const text = response.text || "{}";
        return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    }
}
exports.GeminiProvider = GeminiProvider;
