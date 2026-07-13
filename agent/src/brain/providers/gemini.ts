import { GoogleGenAI } from "@google/genai";

import { appendRawAiInteraction } from "../../logging/aiInteractions";
import {
  aiResponseJsonSchema,
  validateAiResponse,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from "../provider";

function userPayload(input: AiRequest, includeTools: boolean): string {
  return JSON.stringify({
    runtime: input.context.runtime,
    selectedSkill: input.context.selectedSkill,
    ...(includeTools ? { availableTools: input.tools } : {}),
    previousToolSteps: input.steps.map(({ image: _image, ...step }) => step),
    userMessage: input.userMessage,
  });
}

function nativeToolSystemInstruction(system: string): string {
  return [
    system.replace(/- Return strict JSON with exactly one outcome: text, clarification, or toolCall\.\n/, ""),
    "When a tool is needed, call its native function directly. Do not print JSON, markdown, function names, or arguments as text.",
  ].join("\n");
}

function normalizeFunctionName(name: string | undefined): string {
  // Gemini may namespace declared functions as `default_api:<name>`.
  // Only remove that documented provider prefix; all remaining names still go
  // through the local tool registry validation.
  return name?.replace(/^default_api:/, "") || "";
}

function rawToolCall(text: string | undefined): AiResponse["toolCall"] | undefined {
  if (!text) return undefined;
  const candidate = text.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(candidate) as { toolCall?: { name?: unknown; arguments?: unknown } };
    if (typeof parsed.toolCall?.name !== "string" || !parsed.toolCall.arguments || typeof parsed.toolCall.arguments !== "object" || Array.isArray(parsed.toolCall.arguments)) return undefined;
    return { name: normalizeFunctionName(parsed.toolCall.name), arguments: parsed.toolCall.arguments as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

export class GeminiProvider implements AiProvider {
  private readonly client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  async complete(input: AiRequest): Promise<AiResponse> {
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
              responseJsonSchema: aiResponseJsonSchema,
            }),
      },
      contents: [
        ...input.context.history.map((entry) => ({
          role: entry.role === "assistant" ? "model" : "user",
          parts: [{ text: entry.content }],
        })),
        {
          role: "user",
          parts: [
            { text: userPayload(input, !nativeTools) },
            ...(latestImage ? [{ inlineData: { mimeType: latestImage.mimeType, data: latestImage.base64 } }] : []),
          ],
        },
      ],
    };
    appendRawAiInteraction({
      traceId: input.traceId,
      provider: "gemini",
      model: this.model,
      direction: "request",
      payload: request,
    });
    const response = await this.client.models.generateContent(request);
    appendRawAiInteraction({
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
          arguments: (call.args || {}) as Record<string, unknown>,
        },
      };
    }
    const recoveredCall = nativeTools ? rawToolCall(response.text) : undefined;
    if (recoveredCall) return { toolCall: recoveredCall };
    if (nativeTools) return { text: response.text || "Không có thao tác phù hợp." };
    const text = response.text || "{}";
    return validateAiResponse(JSON.parse(text));
  }
}
