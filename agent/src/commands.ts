import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { agentDir, commandsFile } from "./config/paths";
import { log } from "./logging/logger";
import {
  finishCommandRun,
  insertCommandRun,
  nowIso,
  setJsonState,
} from "./storage/repositories";
import { tailLines } from "./utils";
import { loadAgentConfig } from "./config/app";
import { PermissionPolicy } from "./security/permissionPolicy";
import type { PolicyDecision } from "./tools/contracts";

export type AgentCommand = {
  name?: string;
  label: string;
  skillSlug?: string;
  aliases?: string[];
  cwd?: string;
  command: string;
  requiresConfirmation?: boolean;
  externalSideEffect?: boolean;
  timeoutMs?: number;
};

export type CommandMap = Record<string, AgentCommand>;
export type CommandCatalog = {
  byAlias: CommandMap;
  allow: AgentCommand[];
};

type CommandsConfig = {
  commands?: CommandMap;
  allow?: AgentCommand[];
};

export type CommandResult = {
  exitCode: number;
  signal?: NodeJS.Signals;
  output: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
let runningTraceId: string | null = null;

function normalizeCommand(action: AgentCommand): AgentCommand {
  return {
    ...action,
    requiresConfirmation: action.requiresConfirmation ?? true,
  };
}

export function loadCommands(): CommandMap {
  return loadCommandCatalog().byAlias;
}

export function loadCommandCatalog(): CommandCatalog {
  const config = JSON.parse(fs.readFileSync(commandsFile, "utf8")) as CommandsConfig;
  if (config.allow) {
    const allow = config.allow.map(normalizeCommand);
    const byAlias = allow.reduce<CommandMap>((commands, action) => {
      const names = [action.name, ...(action.aliases || [])].filter(Boolean) as string[];
      for (const name of names) {
        commands[name.toLowerCase()] = action;
      }
      return commands;
    }, {});

    return { byAlias, allow };
  }

  const legacy = config.commands || {};
  return {
    byAlias: legacy,
    allow: Object.entries(legacy).map(([name, action]) =>
      normalizeCommand({ ...action, name: action.name || name }),
    ),
  };
}

export function resolveCwd(cwd?: string): string {
  if (!cwd) return agentDir;
  return path.isAbsolute(cwd) ? cwd : path.resolve(agentDir, cwd);
}

export function evaluateCommandPermission(
  action: AgentCommand,
  rawCommand?: string,
  confirmationGranted = false,
): PolicyDecision {
  const config = loadAgentConfig().permissions;
  const policy = new PermissionPolicy(config);
  return policy.evaluate(
    {
      kind: "command.run",
      commandId: action.name || action.label,
      command: rawCommand || action.command,
      cwd: resolveCwd(action.cwd),
      requiresConfirmation: action.requiresConfirmation ?? true,
      externalSideEffect: action.externalSideEffect ?? false,
    },
    { confirmationGranted },
  );
}

export function isCommandRunning(): boolean {
  return runningTraceId !== null;
}

export function getRunningTraceId(): string | null {
  return runningTraceId;
}

export function validateWildcardRawCommand(rawCommand: string): { ok: true } | { ok: false; reason: string } {
  const denyPatterns = [
    /\bsudo\b/,
    /\bsu\b/,
    /\brm\s+-[^\n;|&]*r[^\n;|&]*f\s+\//,
    /\bmkfs(?:\.\w+)?\b/,
    /\bdd\s+/,
    /:\s*\(\)\s*\{/,
    />\s*\/(?:etc|usr|bin|boot)\b/,
    /\b(?:tee|cp|mv|install)\b[^\n;|&]*\/(?:etc|usr|bin|boot)\b/,
    /\b(?:curl|wget)\b[^\n;|&]*\|\s*(?:sh|bash|zsh|fish)\b/,
  ];

  for (const pattern of denyPatterns) {
    if (pattern.test(rawCommand)) {
      return { ok: false, reason: `Rejected by denylist pattern: ${pattern.source}` };
    }
  }

  return { ok: true };
}

function runCommand(
  action: AgentCommand,
  defaultTimeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    exec(
      action.command,
      {
        cwd: resolveCwd(action.cwd),
        env: { ...process.env },
        shell: "/bin/bash",
        timeout: Number(action.timeoutMs || defaultTimeoutMs),
        maxBuffer: 1024 * 1024 * 10,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          signal: error?.signal || undefined,
          output: `${stdout || ""}${stderr || ""}`,
        });
      },
    );
  });
}

export async function runTrackedCommand(input: {
  traceId: string;
  chatId: string;
  action: AgentCommand;
  rawCommand?: string;
  defaultTimeoutMs?: number;
  confirmationGranted?: boolean;
}): Promise<CommandResult> {
  if (runningTraceId) {
    throw new Error(`Command already running for trace ${runningTraceId}`);
  }

  const command = input.rawCommand || input.action.command;
  if (input.action.command === "*" && !input.rawCommand) {
    throw new Error("Wildcard command requires rawCommand.");
  }
  if (input.action.command === "*" && input.rawCommand) {
    const validation = validateWildcardRawCommand(input.rawCommand);
    if (!validation.ok) {
      throw new Error(`${validation.reason}. Run that command manually outside the bot.`);
    }
  }

  const action = { ...input.action, command };
  const policyDecision = evaluateCommandPermission(
    action,
    input.rawCommand,
    input.confirmationGranted,
  );
  if (policyDecision.outcome !== "allow") {
    throw new Error(`Permission ${policyDecision.outcome}: ${policyDecision.reasonCode} - ${policyDecision.reason}`);
  }
  if (policyDecision.action.kind !== "command.run") {
    throw new Error("Permission policy returned an invalid action kind for command execution.");
  }
  action.cwd = policyDecision.action.cwd;
  const cwd = action.cwd;
  const startedAt = nowIso();
  runningTraceId = input.traceId;
  setJsonState("runtime_state", "currentRun", {
    traceId: input.traceId,
    chatId: input.chatId,
    label: action.label,
    skillSlug: action.skillSlug,
    command,
    startedAt,
  });
  insertCommandRun({
    traceId: input.traceId,
    chatId: input.chatId,
    commandName: action.name || action.label,
    label: action.label,
    cwd,
    command,
    startedAt,
  });
  log.info(input.traceId, "command.started", {
    commandName: action.name,
    label: action.label,
    cwd,
  });

  try {
    const result = await runCommand(action, input.defaultTimeoutMs || DEFAULT_TIMEOUT_MS);
    const ok = result.exitCode === 0 && !result.signal;
    const finishedAt = nowIso();
    const outputTail = tailLines(result.output, 80).slice(-4096);
    finishCommandRun({
      traceId: input.traceId,
      status: ok ? "success" : "failed",
      finishedAt,
      exitCode: result.exitCode,
      outputTail,
      errorMessage: ok ? undefined : `Exit ${result.exitCode || result.signal || "unknown"}`,
    });
    setJsonState("runtime_state", "lastRun", {
      traceId: input.traceId,
      label: action.label,
      status: ok ? "success" : "failed",
      finishedAt,
      outputTail,
    });
    if (!ok) {
      setJsonState("runtime_state", "lastError", {
        traceId: input.traceId,
        message: `Command failed: ${action.label}`,
        at: finishedAt,
      });
    }
    log.info(input.traceId, ok ? "command.completed" : "command.failed", {
      exitCode: result.exitCode,
      signal: result.signal,
      outputTail,
    });
    return result;
  } catch (error) {
    const finishedAt = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    finishCommandRun({
      traceId: input.traceId,
      status: "failed",
      finishedAt,
      exitCode: null,
      outputTail: "",
      errorMessage: message,
    });
    setJsonState("runtime_state", "lastError", {
      traceId: input.traceId,
      message,
      stack: error instanceof Error ? error.stack : undefined,
      at: finishedAt,
    });
    log.error(input.traceId, "command.failed", { error });
    throw error;
  } finally {
    runningTraceId = null;
    setJsonState("runtime_state", "currentRun", null);
  }
}
