import { spawn } from "node:child_process";
import crypto from "node:crypto";
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
import { validateJsonSchema, type JsonSchema } from "./tools/schema";

export type AgentCommand = {
  name?: string;
  label: string;
  skillSlug?: string;
  aliases?: string[];
  cwd?: string;
  argv: [string, ...string[]];
  requiresConfirmation?: boolean;
  externalSideEffect?: boolean;
  timeoutMs?: number;
  inputMode?: "json-stdin";
  inputSchema?: JsonSchema;
  invocationInput?: unknown;
};

export type CommandMap = Record<string, AgentCommand>;
export type CommandCatalog = {
  byAlias: CommandMap;
  allow: AgentCommand[];
};

export type CommandsConfig = {
  commands?: CommandMap;
  allow?: AgentCommand[];
};

export type CommandResult = {
  exitCode: number;
  signal?: NodeJS.Signals;
  output: string;
  timedOut: boolean;
  stopped: boolean;
};

export type CommandPreview = {
  commandName: string;
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  requiresConfirmation: boolean;
  externalSideEffect: boolean;
  inputDigest?: string;
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SAFE_ENV_KEYS = [
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;
type RunningCommand = {
  traceId: string;
  child: ReturnType<typeof spawn>;
  stopRequested: boolean;
  killTimer: NodeJS.Timeout | null;
};

let runningCommand: RunningCommand | null = null;

function normalizeCommand(action: AgentCommand): AgentCommand {
  if (!action.name?.trim()) throw new Error("Allowlisted command is missing a name.");
  if (!action.label?.trim()) throw new Error(`Allowlisted command ${action.name} is missing a label.`);
  if (!Array.isArray(action.argv) || !action.argv.length) {
    throw new Error(`Allowlisted command ${action.name} must define a non-empty argv array.`);
  }
  for (const value of action.argv) {
    if (typeof value !== "string" || !value || value.includes("\0")) {
      throw new Error(`Allowlisted command ${action.name} has an invalid argv value.`);
    }
  }
  if (action.inputMode && action.inputMode !== "json-stdin") {
    throw new Error(`Allowlisted command ${action.name} has an unsupported input mode.`);
  }
  if (action.inputMode && !action.inputSchema) {
    throw new Error(`Allowlisted command ${action.name} input mode requires an input schema.`);
  }
  if (action.invocationInput !== undefined) {
    if (!action.inputSchema || action.inputMode !== "json-stdin") {
      throw new Error(`Allowlisted command ${action.name} does not accept structured input.`);
    }
    const errors = validateJsonSchema(action.inputSchema, action.invocationInput);
    if (errors.length) throw new Error(`Invalid input for ${action.name}: ${errors.join(" ")}`);
  }
  const cwd = resolveCwd(action.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new Error(`Allowlisted command ${action.name} has a stale cwd: ${cwd}`);
  }
  if (action.skillSlug) {
    const skillRoot = path.resolve(agentDir, "..", "skills", action.skillSlug);
    if (!fs.existsSync(path.join(skillRoot, "SKILL.md"))) {
      throw new Error(`Allowlisted command ${action.name} references missing skill: ${action.skillSlug}`);
    }
    if (cwd !== fs.realpathSync(skillRoot)) {
      throw new Error(`Allowlisted command ${action.name} cwd does not match skill ${action.skillSlug}.`);
    }
  }
  return {
    ...action,
    cwd,
    requiresConfirmation: action.requiresConfirmation ?? true,
    externalSideEffect: action.externalSideEffect ?? false,
  };
}

export function commandInputDigest(input: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function withCommandInput(action: AgentCommand, input: unknown): AgentCommand {
  const invocation = { ...action, invocationInput: input };
  return normalizeCommand(invocation);
}

export function loadCommands(): CommandMap {
  return loadCommandCatalog().byAlias;
}

export function loadCommandCatalog(): CommandCatalog {
  const config = JSON.parse(fs.readFileSync(commandsFile, "utf8")) as CommandsConfig;
  return buildCommandCatalog(config);
}

export function buildCommandCatalog(config: CommandsConfig): CommandCatalog {
  if (config.allow) {
    const allow = config.allow.map(normalizeCommand);
    const byAlias = allow.reduce<CommandMap>((commands, action) => {
      const names = [action.name, ...(action.aliases || [])].filter(Boolean) as string[];
      for (const name of names) {
        const key = name.toLowerCase();
        if (commands[key]) throw new Error(`Duplicate command name or alias: ${name}`);
        commands[key] = action;
      }
      return commands;
    }, {});

    return { byAlias, allow };
  }

  throw new Error("commands.json must define an allow array using argv-based commands.");
}

export function resolveCwd(cwd?: string): string {
  if (!cwd) return agentDir;
  return path.isAbsolute(cwd) ? cwd : path.resolve(agentDir, cwd);
}

export function evaluateCommandPermission(
  action: AgentCommand,
  confirmationGranted = false,
): PolicyDecision {
  const config = loadAgentConfig().permissions;
  const policy = new PermissionPolicy(config);
  return policy.evaluate(
    {
      kind: "command.run",
      commandId: action.name || action.label,
      executable: action.argv[0],
      args: action.argv.slice(1),
      cwd: resolveCwd(action.cwd),
      requiresConfirmation: action.requiresConfirmation ?? true,
      externalSideEffect: action.externalSideEffect ?? false,
    },
    { confirmationGranted },
  );
}

export function isCommandRunning(): boolean {
  return runningCommand !== null;
}

export function getRunningTraceId(): string | null {
  return runningCommand?.traceId || null;
}

/** Request a graceful stop for the one globally tracked allowlisted command. */
export function stopRunningCommand(): { stopped: boolean; traceId?: string } {
  const running = runningCommand;
  if (!running) return { stopped: false };
  if (running.stopRequested) return { stopped: true, traceId: running.traceId };

  const signalled = running.child.kill("SIGTERM");
  if (!signalled) return { stopped: false };

  running.stopRequested = true;
  running.killTimer = setTimeout(() => {
    if (runningCommand === running) running.child.kill("SIGKILL");
  }, 5_000);
  return { stopped: true, traceId: running.traceId };
}

export function buildCommandEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  env.PATH ||= "/usr/local/bin:/usr/bin:/bin";
  return env;
}

export function previewCommand(
  action: AgentCommand,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
): CommandPreview {
  const normalized = normalizeCommand(action);
  return {
    commandName: normalized.name || normalized.label,
    label: normalized.label,
    executable: normalized.argv[0],
    args: normalized.argv.slice(1),
    cwd: resolveCwd(normalized.cwd),
    timeoutMs: Number(normalized.timeoutMs || defaultTimeoutMs),
    requiresConfirmation: normalized.requiresConfirmation ?? true,
    externalSideEffect: normalized.externalSideEffect ?? false,
    inputDigest:
      normalized.invocationInput === undefined ? undefined : commandInputDigest(normalized.invocationInput),
  };
}

export function commandPreviewDigest(preview: CommandPreview): string {
  const canonical = JSON.stringify({
    commandName: preview.commandName,
    label: preview.label,
    executable: preview.executable,
    args: preview.args,
    cwd: preview.cwd,
    timeoutMs: preview.timeoutMs,
    requiresConfirmation: preview.requiresConfirmation,
    externalSideEffect: preview.externalSideEffect,
    inputDigest: preview.inputDigest,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function runCommand(action: AgentCommand, defaultTimeoutMs: number, traceId: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const preview = previewCommand(action, defaultTimeoutMs);
    const child = spawn(preview.executable, preview.args, {
      cwd: preview.cwd,
      env: buildCommandEnvironment(),
      shell: false,
      stdio: [action.invocationInput === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const running: RunningCommand = { traceId, child, stopRequested: false, killTimer: null };
    runningCommand = running;
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let outputLimited = false;
    let timedOut = false;
    let settled = false;

    if (action.invocationInput !== undefined && child.stdin) {
      child.stdin.end(`${JSON.stringify(action.invocationInput)}\n`);
    }

    const capture = (chunk: Buffer): void => {
      if (outputLimited) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        chunks.push(Buffer.from("\n[output truncated: command exceeded 10 MiB]"));
        outputLimited = true;
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
      outputBytes += chunk.length;
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, preview.timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (running.killTimer) clearTimeout(running.killTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (running.killTimer) clearTimeout(running.killTimer);
      resolve({
        exitCode: timedOut ? 124 : code ?? (signal ? 1 : 0),
        signal: signal || undefined,
        output: Buffer.concat(chunks).toString("utf8"),
        timedOut,
        stopped: running.stopRequested,
      });
    });
  });
}

export async function runTrackedCommand(input: {
  traceId: string;
  chatId: string;
  action: AgentCommand;
  defaultTimeoutMs?: number;
  confirmationGranted?: boolean;
}): Promise<CommandResult> {
  if (runningCommand) {
    throw new Error(`Command already running for trace ${runningCommand.traceId}`);
  }

  const action = normalizeCommand(input.action);
  const policyDecision = evaluateCommandPermission(action, input.confirmationGranted);
  if (policyDecision.outcome !== "allow") {
    throw new Error(`Permission ${policyDecision.outcome}: ${policyDecision.reasonCode} - ${policyDecision.reason}`);
  }
  if (policyDecision.action.kind !== "command.run") {
    throw new Error("Permission policy returned an invalid action kind for command execution.");
  }
  action.cwd = policyDecision.action.cwd;
  const cwd = action.cwd;
  const preview = previewCommand(action, input.defaultTimeoutMs || DEFAULT_TIMEOUT_MS);
  const command = JSON.stringify([
    preview.executable,
    ...preview.args,
    ...(preview.inputDigest ? [`<json-stdin:${preview.inputDigest}>`] : []),
  ]);
  const startedAt = nowIso();
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
    const result = await runCommand(action, input.defaultTimeoutMs || DEFAULT_TIMEOUT_MS, input.traceId);
    const ok = result.exitCode === 0 && !result.signal;
    const finishedAt = nowIso();
    const outputTail = tailLines(result.output, 80).slice(-4096);
    finishCommandRun({
      traceId: input.traceId,
      status: ok ? "success" : "failed",
      finishedAt,
      exitCode: result.exitCode,
      outputTail,
      errorMessage: ok ? undefined : result.stopped ? "Stopped by user." : `Exit ${result.exitCode || result.signal || "unknown"}`,
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
        message: result.stopped ? `Command stopped: ${action.label}` : `Command failed: ${action.label}`,
        at: finishedAt,
      });
    }
    log.info(input.traceId, ok ? "command.completed" : result.stopped ? "command.stopped" : "command.failed", {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
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
    runningCommand = null;
    setJsonState("runtime_state", "currentRun", null);
  }
}
