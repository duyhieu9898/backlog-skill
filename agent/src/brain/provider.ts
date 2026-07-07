import type { JsonSchema } from "../tools/schema";

export type AiToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type AiToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type AiToolStep = {
  call: AiToolCall;
  result: unknown;
};

export type AiRequest = {
  system: string;
  context: string;
  userMessage: string;
  tools: AiToolDefinition[];
  steps: AiToolStep[];
};

export type AiResponse = {
  text?: string;
  toolCall?: AiToolCall;
  clarification?: string;
  usage?: unknown;
};

export function validateAiResponse(value: unknown): AiResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI response must be a JSON object.");
  }
  const response = value as Record<string, unknown>;
  const outcomes = [response.text, response.clarification, response.toolCall].filter(
    (item) => item !== undefined,
  );
  if (outcomes.length !== 1) throw new Error("AI response must contain exactly one outcome.");
  if (response.text !== undefined && typeof response.text !== "string") {
    throw new Error("AI response text must be a string.");
  }
  if (response.clarification !== undefined && typeof response.clarification !== "string") {
    throw new Error("AI response clarification must be a string.");
  }
  let toolCall: AiToolCall | undefined;
  if (response.toolCall !== undefined) {
    if (!response.toolCall || typeof response.toolCall !== "object" || Array.isArray(response.toolCall)) {
      throw new Error("AI toolCall must be an object.");
    }
    const candidate = response.toolCall as Record<string, unknown>;
    if (typeof candidate.name !== "string" || !candidate.name.trim()) {
      throw new Error("AI toolCall name must be a non-empty string.");
    }
    if (!candidate.arguments || typeof candidate.arguments !== "object" || Array.isArray(candidate.arguments)) {
      throw new Error("AI toolCall arguments must be an object.");
    }
    toolCall = { name: candidate.name, arguments: candidate.arguments as Record<string, unknown> };
  }
  return {
    text: response.text as string | undefined,
    clarification: response.clarification as string | undefined,
    toolCall,
    usage: response.usage,
  };
}

export interface AiProvider {
  complete(input: AiRequest): Promise<AiResponse>;
}
