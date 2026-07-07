import OpenAI from "openai";

import { validateAiResponse, type AiProvider, type AiRequest, type AiResponse } from "../provider";

export class OpenAiProvider implements AiProvider {
  private readonly client: OpenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new OpenAI({ apiKey });
  }

  async complete(input: AiRequest): Promise<AiResponse> {
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
    return { ...validateAiResponse(JSON.parse(content)), usage: response.usage };
  }
}
