"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateAiResponse = validateAiResponse;
function validateAiResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("AI response must be a JSON object.");
    }
    const response = value;
    const outcomes = [response.text, response.clarification, response.toolCall].filter((item) => item !== undefined);
    if (outcomes.length !== 1)
        throw new Error("AI response must contain exactly one outcome.");
    if (response.text !== undefined && typeof response.text !== "string") {
        throw new Error("AI response text must be a string.");
    }
    if (response.clarification !== undefined && typeof response.clarification !== "string") {
        throw new Error("AI response clarification must be a string.");
    }
    let toolCall;
    if (response.toolCall !== undefined) {
        if (!response.toolCall || typeof response.toolCall !== "object" || Array.isArray(response.toolCall)) {
            throw new Error("AI toolCall must be an object.");
        }
        const candidate = response.toolCall;
        if (typeof candidate.name !== "string" || !candidate.name.trim()) {
            throw new Error("AI toolCall name must be a non-empty string.");
        }
        if (!candidate.arguments || typeof candidate.arguments !== "object" || Array.isArray(candidate.arguments)) {
            throw new Error("AI toolCall arguments must be an object.");
        }
        toolCall = { name: candidate.name, arguments: candidate.arguments };
    }
    return {
        text: response.text,
        clarification: response.clarification,
        toolCall,
        usage: response.usage,
    };
}
