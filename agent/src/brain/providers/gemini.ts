import { GoogleGenAI } from "@google/genai";

import type { AiProvider, AiRequest, AiResponse } from "../provider";

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
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")) as AiResponse;
  }
}
