import OpenAI from "openai";

import { validateAiResponse, type AiProvider, type AiRequest, type AiResponse } from "../provider";

function userPayload(input: AiRequest): string {
  return JSON.stringify({
    runtime: input.context.runtime,
    selectedSkill: input.context.selectedSkill,
    availableTools: input.tools,
    previousToolSteps: input.steps,
    userMessage: input.userMessage,
  });
}

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
        ...input.context.history.map((entry) => ({
          role: entry.role === "assistant" ? "assistant" as const : "user" as const,
          content: entry.content,
        })),
        {
          role: "user",
          content: userPayload(input),
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = response.choices[0]?.message.content || "{}";
    return { ...validateAiResponse(JSON.parse(content)), usage: response.usage };
  }
}
