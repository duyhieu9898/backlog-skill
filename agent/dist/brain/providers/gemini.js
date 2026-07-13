"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GeminiProvider = void 0;
const genai_1 = require("@google/genai");
const aiInteractions_1 = require("../../logging/aiInteractions");
const provider_1 = require("../provider");
function userPayload(input, includeTools) {
    return JSON.stringify({
        runtime: input.context.runtime,
        selectedSkill: input.context.selectedSkill,
        ...(includeTools ? { availableTools: input.tools } : {}),
        previousToolSteps: input.steps.map(({ image: _image, ...step }) => step),
        userMessage: input.userMessage,
    });
}
function nativeToolSystemInstruction(system) {
    return [
        system.replace(/- Return strict JSON with exactly one outcome: text, clarification, or toolCall\.\n/, ""),
        "When a tool is needed, call its native function directly. Do not print JSON, markdown, function names, or arguments as text.",
    ].join("\n");
}
function normalizeFunctionName(name) {
    // Gemini may namespace declared functions as `default_api:<name>`.
    // Only remove that documented provider prefix; all remaining names still go
    // through the local tool registry validation.
    return name?.replace(/^default_api:/, "") || "";
}
function rawToolCall(text) {
    if (!text)
        return undefined;
    const candidate = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
    try {
        const parsed = JSON.parse(candidate);
        if (typeof parsed.toolCall?.name !== "string" || !parsed.toolCall.arguments || typeof parsed.toolCall.arguments !== "object" || Array.isArray(parsed.toolCall.arguments))
            return undefined;
        return { name: normalizeFunctionName(parsed.toolCall.name), arguments: parsed.toolCall.arguments };
    }
    catch {
        return undefined;
    }
}
class GeminiProvider {
    model;
    client;
    constructor(apiKey, model) {
        this.model = model;
        this.client = new genai_1.GoogleGenAI({ apiKey });
    }
    async complete(input) {
        const nativeTools = input.tools.length
            ? [{
                    functionDeclarations: input.tools.map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        parametersJsonSchema: tool.inputSchema,
                    })),
                }]
            : undefined;
        const latestImage = input.steps.at(-1)?.image;
        const request = {
            model: this.model,
            config: {
                systemInstruction: nativeTools ? nativeToolSystemInstruction(input.system) : input.system,
                ...(nativeTools
                    ? { tools: nativeTools }
                    : {
                        responseMimeType: "application/json",
                        responseJsonSchema: provider_1.aiResponseJsonSchema,
                    }),
            },
            contents: [
                ...input.context.history.map((entry) => {
                    if (entry.role === "system") {
                        return {
                            role: "user",
                            parts: [{ text: `[SYSTEM SUMMARY]: ${entry.content}` }],
                        };
                    }
                    return {
                        role: entry.role === "assistant" ? "model" : "user",
                        parts: [{ text: entry.content }],
                    };
                }),
                {
                    role: "user",
                    parts: [
                        { text: userPayload(input, !nativeTools) },
                        ...(latestImage ? [{ inlineData: { mimeType: latestImage.mimeType, data: latestImage.base64 } }] : []),
                    ],
                },
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
        const call = response.functionCalls?.[0];
        if (call) {
            return {
                toolCall: {
                    name: normalizeFunctionName(call.name),
                    arguments: (call.args || {}),
                },
            };
        }
        const recoveredCall = nativeTools ? rawToolCall(response.text) : undefined;
        if (recoveredCall)
            return { toolCall: recoveredCall };
        if (nativeTools)
            return { text: response.text || "Không có thao tác phù hợp." };
        const text = response.text || "{}";
        return (0, provider_1.validateAiResponse)(JSON.parse(text));
    }
}
exports.GeminiProvider = GeminiProvider;
