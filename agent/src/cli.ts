import path from "node:path";

import { inputFromArgs, toCliMessage } from "./adapters/cli";
import { agentDir } from "./config/paths";
import { loadEnv } from "./config/env";
import { Router } from "./core/router";
import { SkillRegistry } from "./skills/registry";
import { getArtifact } from "./storage/repositories";
import { stopRunningCommand, waitForRunningCommandStop } from "./commands";
import { performGracefulShutdown } from "./core/shutdown";
import { browserService } from "./browser/browser-service";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input.trim()));
    process.stdin.on("error", reject);
  });
}

export async function runCli(args = process.argv.slice(2)): Promise<number> {
  loadEnv(path.join(agentDir, ".env"));
  const json = args.includes("--json");
  const sessionFlag = args.indexOf("--session");
  const session = sessionFlag >= 0 ? args[sessionFlag + 1] : undefined;
  if (sessionFlag >= 0 && (!session || session.startsWith("--"))) {
    process.stderr.write("Agent lỗi: --session requires a non-empty value.\n");
    return 2;
  }
  const messageArgs = args.filter((arg, index) => {
    if (arg === "--json") return false;
    return sessionFlag < 0 || (index !== sessionFlag && index !== sessionFlag + 1);
  });
  const text = inputFromArgs(messageArgs) || (process.stdin.isTTY ? "" : await readStdin());
  if (!text) {
    process.stderr.write('Usage: npm run cli -- [--session <id>] "<message>"\n');
    return 2;
  }

  let exitCode = 0;
  try {
    const router = new Router(new SkillRegistry());
    const message = toCliMessage(text, { session });
    let artifactId: string | undefined;
    const reply = await router.route(message, undefined, (id) => { artifactId = id; });
    const artifact = artifactId ? getArtifact(artifactId) : null;
    if (json) {
      process.stdout.write(`${JSON.stringify({
        traceId: message.traceId,
        reply,
        artifact: artifact && { id: artifact.id, mimeType: artifact.mime_type, byteSize: artifact.byte_size, path: artifact.local_path },
      })}\n`);
    } else {
      process.stdout.write(`${reply}${artifact ? `\nArtifact: ${artifact.local_path}` : ""}\n`);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Agent lỗi: ${message}\n`);
    exitCode = 1;
  } finally {
    // Tear down browser/command handles so the process exits. Without this the
    // managed Chromium keeps the Node event loop alive and `npm run cli` hangs
    // after printing its result whenever a run used the browser tool.
    await performGracefulShutdown({
      stopRunningCommand,
      waitForRunningCommandStop,
      browserShutdown: () => browserService.shutdown(),
    }).catch(() => {
      // Best-effort: a shutdown failure must not mask the run's result.
    });
  }
  return exitCode;
}

if (require.main === module) {
  runCli()
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Agent lỗi: ${message}\n`);
      process.exit(1);
    });
}
