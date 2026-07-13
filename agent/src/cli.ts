import path from "node:path";

import { inputFromArgs, toCliMessage } from "./adapters/cli";
import { agentDir } from "./config/paths";
import { loadEnv } from "./config/env";
import { Router } from "./core/router";
import { SkillRegistry } from "./skills/registry";

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
  const text = inputFromArgs(args) || (process.stdin.isTTY ? "" : await readStdin());
  if (!text) {
    process.stderr.write('Usage: npm run cli -- "<message>"\n');
    return 2;
  }

  const router = new Router(new SkillRegistry());
  const reply = await router.route(toCliMessage(text));
  process.stdout.write(`${reply}\n`);
  return 0;
}

if (require.main === module) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Agent lỗi: ${message}\n`);
      process.exitCode = 1;
    });
}
