import { tailLines } from "../utils";
import { ArtifactStore, type Artifact } from "../artifacts/store";

export type PresentedResponse = { text: string; artifact?: Artifact };

export function presentArtifact(text: string, artifact: Artifact): PresentedResponse {
  return { text, artifact };
}

export type ResponseDeliveryChannel = {
  sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<void>;
  sendArtifact(chatId: string, artifact: Artifact): Promise<void>;
};

export async function deliverResponse(
  channel: ResponseDeliveryChannel,
  chatId: string,
  response: PresentedResponse,
  replyMarkup?: unknown,
  artifacts = new ArtifactStore(),
): Promise<void> {
  if (response.artifact) {
    const artifact = artifacts.claim(response.artifact.id, chatId);
    await channel.sendMessage(chatId, response.text, replyMarkup);
    await channel.sendArtifact(chatId, artifact);
    artifacts.markDelivered(artifact.id);
    return;
  }
  await channel.sendMessage(chatId, response.text, replyMarkup);
}

function cleanOutput(output: string): string {
  return output
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      // Loại bỏ boilerplate của npm run/start
      if (trimmed.startsWith("> ")) return false;
      // Loại bỏ log của thư viện dotenv
      if (trimmed.startsWith("[dotenv@")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

export function presentCommandResult(input: {
  label: string;
  traceId: string;
  ok: boolean;
  exit: string;
  output: string;
}): string {
  const cleaned = cleanOutput(input.output);
  const shortOutput = cleaned.length <= 1200 ? cleaned : tailLines(cleaned, 20);
  const truncated = cleaned.length > shortOutput.length ? "\n[truncated: showing latest command output]" : "";

  return [
    input.ok ? `${input.label} thành công` : `${input.label} thất bại`,
    `traceId: ${input.traceId}`,
    input.ok ? "" : `exit: ${input.exit}`,
    "",
    shortOutput ? `${shortOutput}${truncated}` : "(no output)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
