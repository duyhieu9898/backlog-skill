import { GoogleGenAI } from "@google/genai";

import { validateAiResponse, type AiProvider, type AiRequest, type AiResponse } from "../provider";

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
      ],
    });
    const text = response.text || "{}";
    return validateAiResponse(JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")));
  }
}
