import fs from "node:fs";

import { configFile, systemPromptFile } from "./paths";

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
};

export function loadAgentConfig(): AgentConfig {
  if (!fs.existsSync(configFile)) return defaultConfig;
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<AgentConfig>;
  return {
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
