import OpenAI from "openai";

import { appendRawAiInteraction } from "../../logging/aiInteractions";
import { validateAiResponse, type AiProvider, type AiRequest, type AiResponse } from "../provider";

function userPayload(input: AiRequest): string {
  return JSON.stringify({
    runtime: input.context.runtime,
    memory: input.context.memory,
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
    const request = {
      model: this.model,
      messages: [
        { role: "system" as const, content: input.system },
        ...input.context.history.map((entry) => ({
          role: entry.role === "assistant" ? "assistant" as const : entry.role === "system" ? "system" as const : "user" as const,
          content: entry.content,
        })),
        {
          role: "user" as const,
          content: userPayload(input),
        },
      ],
      response_format: { type: "json_object" as const },
    };
    appendRawAiInteraction({
      traceId: input.traceId,
      provider: "openai",
      model: this.model,
      direction: "request",
      payload: request,
    });
    const response = await this.client.chat.completions.create(request);
    appendRawAiInteraction({
      traceId: input.traceId,
      provider: "openai",
      model: this.model,
      direction: "response",
      payload: response,
    });

    const content = response.choices[0]?.message.content || "{}";
    return { ...validateAiResponse(JSON.parse(content)), usage: response.usage };
  }
}
