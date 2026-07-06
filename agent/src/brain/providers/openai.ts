import OpenAI from "openai";

import type { AiProvider, AiRequest, AiResponse } from "../provider";

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
            "Return strict JSON with optional keys: text, commandName, clarification.",
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
    return { ...(JSON.parse(content) as AiResponse), usage: response.usage };
  }
}
