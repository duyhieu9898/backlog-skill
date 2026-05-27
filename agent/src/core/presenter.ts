import { tailLines } from "../utils";

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
