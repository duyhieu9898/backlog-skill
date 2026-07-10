import { GoogleGenAI } from "@google/genai";

import {
  aiResponseJsonSchema,
  validateAiResponse,
  type AiProvider,
  type AiRequest,
  type AiResponse,
} from "../provider";

function userPayload(input: AiRequest): string {
  return JSON.stringify({
    runtime: input.context.runtime,
    selectedSkill: input.context.selectedSkill,
    availableTools: input.tools,
    previousToolSteps: input.steps,
    userMessage: input.userMessage,
  });
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
    const response = await this.client.models.generateContent({
      model: this.model,
      config: {
        systemInstruction: input.system,
        responseMimeType: "application/json",
        responseJsonSchema: aiResponseJsonSchema,
      },
      contents: [
        ...input.context.history.map((entry) => ({
          role: entry.role === "assistant" ? "model" : "user",
          parts: [{ text: entry.content }],
        })),
        { role: "user", parts: [{ text: userPayload(input) }] },
      ],
    });
    const text = response.text || "{}";
    return validateAiResponse(JSON.parse(text));
  }
}
