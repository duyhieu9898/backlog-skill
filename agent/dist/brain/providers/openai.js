"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenAiProvider = void 0;
const openai_1 = __importDefault(require("openai"));
const provider_1 = require("../provider");
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
                },
            ],
            response_format: { type: "json_object" },
        });
        const content = response.choices[0]?.message.content || "{}";
        return { ...(0, provider_1.validateAiResponse)(JSON.parse(content)), usage: response.usage };
    }
}
exports.OpenAiProvider = OpenAiProvider;
