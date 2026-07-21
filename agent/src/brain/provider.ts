import type { JsonSchema } from "../tools/schema";
import type { ModelImage } from "../tools/media/image-context";

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
  /** Ephemeral media for the next model turn; never serialize into tool text. */
  image?: ModelImage;
};

export type AiChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type AiRuntimeContext = {
  currentTime: string;
  timezone: string;
  locale: string;
  lastFailureSummary?: string;
};

export const capabilityNames = ["file-read", "file-write", "web", "desktop-observe", "desktop-control", "command", "skill"] as const;
export type Capability = (typeof capabilityNames)[number];

export type CapabilityRoute = {
  capabilities: Capability[];
  targets: string[];
  continuation: "new" | "continued" | "cleared";
  confidence: "hard-signal" | "lease" | "low";
  selectionReason: string;
  skillSlug?: string;
};

export type ActiveScopeLease = {
  capabilities: Capability[];
  targets: string[];
  taskSummary: string;
  sourceTurn: string;
  state: "active";
  expiresAt: string;
  skillSlug?: string;
};

export type VisibleToolSnapshot = {
  names: string[];
  schemaHash: string;
  route: CapabilityRoute;
};

export type AiPromptContext = {
  history: AiChatTurn[];
  /** Relevant durable facts; never a wholesale replay of MEMORY.md. */
  memory?: string[];
  runtime: AiRuntimeContext;
  selectedSkill?: {
    slug: string;
    name: string;
    description: string;
    instructions?: string;
  };
  capabilityRoute: CapabilityRoute;
};

export type AiRequest = {
  traceId: string;
  system: string;
  context: AiPromptContext;
  userMessage: string;
  tools: AiToolDefinition[];
  steps: AiToolStep[];
};

export const aiResponseJsonSchema = {
  anyOf: [
    {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { clarification: { type: "string" } },
      required: ["clarification"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        toolCall: {
          type: "object",
          properties: {
            name: { type: "string" },
            arguments: { type: "object" },
          },
          required: ["name", "arguments"],
          additionalProperties: false,
        },
      },
      required: ["toolCall"],
      additionalProperties: false,
    },
  ],
} as const;

export type AiResponse = {
  text?: string;
  toolCall?: AiToolCall;
  clarification?: string;
  usage?: unknown;
};

export type NormalizedUsage = {
  providerReported: {
    inputTokensTotal?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    inputByModality?: Record<string, number>;
    cachedByModality?: Record<string, number>;
    observedModalities?: string[];
    // Slimmed token-relevant fields only. The full raw provider payload lives
    // in the appendRawAiInteraction log; this summary avoids duplicating heavy
    // request/response content into every ai.response.received log line.
    rawSummary: unknown;
  };
  clientEstimated: {
    textTokens: number;
    toolSchemaTokens: number;
    toolResultTokens: number;
    imageTokens: number;
    estimator: { name: string; version: string; confidence: "low" | "medium" };
  };
};

export function validateAiResponse(value: unknown): AiResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI response must be a JSON object.");
  }
  const response = value as Record<string, unknown>;
  const allowedKeys = new Set(["text", "clarification", "toolCall", "usage"]);
  if (Object.keys(response).some((key) => !allowedKeys.has(key))) {
    throw new Error("AI response contains unsupported fields.");
  }
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
