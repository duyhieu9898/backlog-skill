import { generateTraceId } from "../logging/trace";
import type { StandardMessage } from "../types/messages";

export const LOCAL_CLI_CHAT_ID = "local-cli";
export const LOCAL_CLI_USER_ID = "local-cli";

export type CliMessageOptions = {
  /**
   * A caller-selected conversation namespace. Normal CLI use deliberately
   * keeps the stable local-cli chat ID so a later process can approve a
   * pending action. Eval runners must opt into a unique namespace instead.
   */
  session?: string;
};

export function cliChatId(session?: string): string {
  if (!session) return LOCAL_CLI_CHAT_ID;
  const normalized = session.trim();
  if (!normalized) throw new Error("CLI session must not be empty.");
  if (normalized.length > 160) throw new Error("CLI session must be at most 160 characters.");
  return `${LOCAL_CLI_CHAT_ID}:session:${normalized}`;
}

export function toCliMessage(text: string, options: CliMessageOptions = {}): StandardMessage {
  return {
    traceId: generateTraceId(),
    provider: "cli",
    chatId: cliChatId(options.session),
    userId: LOCAL_CLI_USER_ID,
    text,
    timestamp: new Date(),
  };
}

export function inputFromArgs(args: string[]): string {
  return args.join(" ").trim();
}
