export type AiRequest = {
  system: string;
  context: string;
  userMessage: string;
};

export type AiResponse = {
  text?: string;
  commandName?: string;
  rawCommand?: string;
  clarification?: string;
  usage?: unknown;
};

export interface AiProvider {
  complete(input: AiRequest): Promise<AiResponse>;
}
