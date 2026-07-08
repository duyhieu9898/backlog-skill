import fs from "node:fs";
import path from "node:path";

import { agentDir, configFile, repoDir, skillsDir, systemPromptFile } from "./paths";

export type AiProviderConfig = {
  default: "openai" | "gemini";
  providers: {
    openai?: {
      apiKeyEnv: string;
      model: string;
    };
    gemini?: {
      apiKeyEnv: string;
      model: string;
    };
  };
};

export type AgentConfig = {
  ai: AiProviderConfig;
  runtime?: {
    commandTimeoutMs?: number;
  };
  schedules?: ScheduledCheckConfig[];
  permissions: {
    workspaceRoot: string;
    allowedReadRoots: string[];
    allowedWriteRoots: string[];
    deniedPaths: string[];
  };
};

export type ScheduledCheckConfig = {
  name: string;
  label?: string;
  command: string;
  intervalMinutes: number;
  enabled?: boolean;
  delivery?: "telegram" | "silent";
  notifyOnChangeOnly?: boolean;
  prepareEffect?: {
    prepareCommand: string;
    prepareInput?: unknown;
    effectCommand: string;
  };
};

const defaultConfig: AgentConfig = {
  ai: {
    default: "gemini",
    providers: {
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-4.1-mini",
      },
      gemini: {
        apiKeyEnv: "GEMINI_API_KEY",
        model: "gemini-2.5-flash",
      },
    },
  },
  runtime: {
    commandTimeoutMs: 10 * 60 * 1000,
  },
  schedules: [],
  permissions: {
    workspaceRoot: repoDir,
    allowedReadRoots: [repoDir],
    allowedWriteRoots: [agentDir, skillsDir],
    deniedPaths: ["/etc", "/usr", "/bin", "/boot", "/proc", "/sys", "/dev"],
  },
};

export function loadAgentConfig(): AgentConfig {
  if (!fs.existsSync(configFile)) return defaultConfig;
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<AgentConfig>;
  const merged = {
    ...defaultConfig,
    ...config,
    ai: {
      ...defaultConfig.ai,
      ...config.ai,
      providers: {
        ...defaultConfig.ai.providers,
        ...config.ai?.providers,
      },
    },
    runtime: {
      ...defaultConfig.runtime,
      ...config.runtime,
    },
    schedules: config.schedules || defaultConfig.schedules,
    permissions: {
      ...defaultConfig.permissions,
      ...config.permissions,
    },
  };
  const resolveFromAgent = (candidate: string): string =>
    path.isAbsolute(candidate) ? candidate : path.resolve(agentDir, candidate);
  return {
    ...merged,
    permissions: {
      workspaceRoot: resolveFromAgent(merged.permissions.workspaceRoot),
      allowedReadRoots: merged.permissions.allowedReadRoots.map(resolveFromAgent),
      allowedWriteRoots: merged.permissions.allowedWriteRoots.map(resolveFromAgent),
      deniedPaths: merged.permissions.deniedPaths.map(resolveFromAgent),
    },
  };
}

export function loadSystemPrompt(): string {
  if (!fs.existsSync(systemPromptFile)) {
    return [
      "You are a local Telegram agent orchestrator.",
      "Choose only allowed commands when command execution is needed.",
      "Reply concisely in the user's language.",
    ].join("\n");
  }
  return fs.readFileSync(systemPromptFile, "utf8");
}
