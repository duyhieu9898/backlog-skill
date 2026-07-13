import { generateTraceId } from "../logging/trace";
import type { StandardMessage } from "../types/messages";

export const LOCAL_CLI_CHAT_ID = "local-cli";
export const LOCAL_CLI_USER_ID = "local-cli";

export function toCliMessage(text: string): StandardMessage {
  return {
    traceId: generateTraceId(),
    provider: "cli",
    chatId: LOCAL_CLI_CHAT_ID,
    userId: LOCAL_CLI_USER_ID,
    text,
    timestamp: new Date(),
  };
}

export function inputFromArgs(args: string[]): string {
  return args.join(" ").trim();
}
