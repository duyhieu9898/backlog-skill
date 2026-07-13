export type StandardMessage = {
  traceId: string;
  provider: "telegram" | "cli";
  chatId: string;
  userId: string;
  text: string;
  timestamp: Date;
};

export type ChatMessage = {
  chatId: string;
  userId: string;
  role: "user" | "assistant" | "system";
  content: string;
  traceId: string;
  createdAt: string;
};
