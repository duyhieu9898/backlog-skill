"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAiProvider = void 0;
const openai_1 = __importDefault(require("openai"));
class OpenAiProvider {
    model;
    client;
    constructor(apiKey, model) {
        this.model = model;
        this.client = new openai_1.default({ apiKey });
    }
    async complete(input) {
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: "system", content: input.system },
                {
                    role: "user",
                    content: [
                        "Return strict JSON with optional keys: text, commandName, clarification.",
                        "Context:",
                        input.context,
                        "User:",
                        input.userMessage,
                    ].join("\n\n"),
                },
            ],
            response_format: { type: "json_object" },
        });
        const content = response.choices[0]?.message.content || "{}";
        return { ...JSON.parse(content), usage: response.usage };
    }
}
exports.OpenAiProvider = OpenAiProvider;
