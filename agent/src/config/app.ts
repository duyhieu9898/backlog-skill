import fs from "node:fs";
import path from "node:path";

import { agentDir, configFile, memoryFile, repoDir, skillsDir, systemPromptFile } from "./paths";
import type { DesktopAppDefinition } from "../tools/computer/contracts";
import { DesktopRegistry } from "../tools/computer/apps";

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
    timezone?: string;
    locale?: string;
  };
  schedules?: ScheduledCheckConfig[];
  desktop?: {
    apps?: DesktopAppDefinition[];
  };
  permissions: {
    workspaceRoot: string;
    allowedReadRoots: string[];
    allowedWriteRoots: string[];
    deniedPaths: string[];
    desktopAppIds?: string[];
    desktopCaptureRequiresConfirmation?: boolean;
  };
};

export type ScheduledCheckConfig = {
  name: string;
  label?: string;
  command: string;
  /** Standard 5-field cron expression, e.g. "0 17 * * 1-5" (Mon–Fri at 17:00). */
  cron: string;
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
    timezone: "Asia/Ho_Chi_Minh",
    locale: "vi-VN",
  },
  schedules: [],
  desktop: {
    apps: [],
  },
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
    desktop: {
      ...defaultConfig.desktop,
      ...config.desktop,
    },
    permissions: {
      ...defaultConfig.permissions,
      ...config.permissions,
    },
  };
  const resolveFromAgent = (candidate: string): string =>
    path.isAbsolute(candidate) ? candidate : path.resolve(agentDir, candidate);
  const desktopApps = new DesktopRegistry(merged.desktop.apps || []).list();
  return {
    ...merged,
    desktop: {
      ...merged.desktop,
      apps: desktopApps,
    },
    permissions: {
      ...merged.permissions,
      workspaceRoot: resolveFromAgent(merged.permissions.workspaceRoot),
      allowedReadRoots: merged.permissions.allowedReadRoots.map(resolveFromAgent),
      allowedWriteRoots: merged.permissions.allowedWriteRoots.map(resolveFromAgent),
      deniedPaths: merged.permissions.deniedPaths.map(resolveFromAgent),
      desktopAppIds: desktopApps.map((app) => app.id),
    },
  };
}

export function loadSystemPrompt(): string {
  let basePrompt = "";
  if (!fs.existsSync(systemPromptFile)) {
    basePrompt = [
      "You are a local Telegram agent orchestrator.",
      "Choose only allowed commands when command execution is needed.",
      "Reply concisely in the user's language.",
    ].join("\n");
  } else {
    basePrompt = fs.readFileSync(systemPromptFile, "utf8");
  }

  if (fs.existsSync(memoryFile)) {
    const memory = fs.readFileSync(memoryFile, "utf8").trim();
    if (memory) {
      basePrompt += `\n\n# LONG-TERM MEMORY (Ký ức dài hạn)\nBên dưới là các thông tin dài hạn quan trọng về Preferences, Rules đặc thù được lưu trữ từ các phiên trò chuyện trước. Hãy luôn tuân thủ các thông tin này:\n\n${memory}`;
    }
  }

  return basePrompt;
}
