import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

export type BrowserCleanupConfig = {
  sweepMinutes?: number;
  idleMinutes?: number;
  maxTabsPerProfile?: number;
  snapshotTtlMinutes?: number;
};

export type BrowserShutdownConfig = {
  gracefulTimeoutMs?: number;
  forceKillTimeoutMs?: number;
};

export type BrowserProfileConfig = {
  persistent?: boolean;
  mode?: "managed" | "cdp";
  endpoint?: string;
};

export type BrowserResourceConfig = {
  profilesRoot?: string;
  defaultPersistent?: boolean;
  cleanup?: BrowserCleanupConfig;
  shutdown?: BrowserShutdownConfig;
  profiles?: Record<string, BrowserProfileConfig>;
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
    browser?: BrowserPermissionConfig;
  };
  browser?: BrowserResourceConfig;
};

export type BrowserPermissionMode = "allow" | "confirm" | "deny";

export type BrowserPermissionConfig = {
  allowedHosts?: string[];
  publicNavigation?: BrowserPermissionMode;
  privateNavigation?: BrowserPermissionMode;
  consequentialActions?: BrowserPermissionMode;
  destructiveActions?: BrowserPermissionMode;
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


const DEFAULT_BROWSER_PERMISSIONS: BrowserPermissionConfig = {
  allowedHosts: [],
  publicNavigation: "allow",
  privateNavigation: "deny",
  consequentialActions: "confirm",
  destructiveActions: "confirm",
};

export const DEFAULT_BROWSER_RESOURCE_CONFIG: Required<Omit<BrowserResourceConfig, "profiles">> & { profiles: Record<string, BrowserProfileConfig> } = {
  profilesRoot: "~/.my-agent/browser/profiles",
  defaultPersistent: true,
  cleanup: {
    sweepMinutes: 5,
    idleMinutes: 30,
    maxTabsPerProfile: 10,
    snapshotTtlMinutes: 10,
  },
  shutdown: {
    gracefulTimeoutMs: 10000,
    forceKillTimeoutMs: 5000,
  },
  profiles: {},
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
    browser: DEFAULT_BROWSER_PERMISSIONS,
  },
  browser: DEFAULT_BROWSER_RESOURCE_CONFIG,
};

function validateBrowserConfig(browser: any) {
  if (!browser) return;
  const { cleanup, shutdown, profilesRoot, profiles } = browser;
  if (cleanup) {
    if (typeof cleanup.sweepMinutes === "number" && cleanup.sweepMinutes <= 0) {
      throw new Error("Invalid config: sweepMinutes must be > 0");
    }
    if (typeof cleanup.idleMinutes === "number" && cleanup.idleMinutes <= 0) {
      throw new Error("Invalid config: idleMinutes must be > 0");
    }
    if (typeof cleanup.maxTabsPerProfile === "number" && cleanup.maxTabsPerProfile < 1) {
      throw new Error("Invalid config: maxTabsPerProfile must be >= 1");
    }
    if (typeof cleanup.snapshotTtlMinutes === "number" && cleanup.snapshotTtlMinutes <= 0) {
      throw new Error("Invalid config: snapshotTtlMinutes must be > 0");
    }
  }
  if (shutdown) {
    if (typeof shutdown.gracefulTimeoutMs === "number" && shutdown.gracefulTimeoutMs <= 0) {
      throw new Error("Invalid config: gracefulTimeoutMs must be positive");
    }
    if (typeof shutdown.forceKillTimeoutMs === "number" && shutdown.forceKillTimeoutMs <= 0) {
      throw new Error("Invalid config: forceKillTimeoutMs must be positive");
    }
  }
  if (profilesRoot) {
    if (!path.isAbsolute(profilesRoot)) {
      throw new Error("Invalid config: profilesRoot must resolve to an absolute path");
    }
  }
  if (profiles) {
    for (const [name, profileSpec] of Object.entries(profiles) as [string, any][]) {
      if (profileSpec.mode === "cdp") {
        if (!profileSpec.endpoint) {
          throw new Error(`Invalid config: CDP profile "${name}" must have an endpoint`);
        }
        if (typeof profileSpec.endpoint !== "string" || profileSpec.endpoint.trim() === "") {
          throw new Error(`Invalid config: CDP profile "${name}" endpoint must be a non-empty string`);
        }
      }
    }
  }
}

export function loadAgentConfig(): AgentConfig {
  let config: Partial<AgentConfig> = {};
  if (fs.existsSync(configFile)) {
    try {
      config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Partial<AgentConfig>;
    } catch (e) {
      console.error("Failed to parse config file, using defaults:", e);
    }
  }

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
      browser: {
        ...DEFAULT_BROWSER_PERMISSIONS,
        ...config.permissions?.browser,
      },
    },
    browser: {
      profilesRoot: config.browser?.profilesRoot ?? defaultConfig.browser?.profilesRoot,
      defaultPersistent: config.browser?.defaultPersistent ?? defaultConfig.browser?.defaultPersistent,
      cleanup: {
        sweepMinutes: config.browser?.cleanup?.sweepMinutes ?? defaultConfig.browser?.cleanup?.sweepMinutes,
        idleMinutes: config.browser?.cleanup?.idleMinutes ?? defaultConfig.browser?.cleanup?.idleMinutes,
        maxTabsPerProfile: config.browser?.cleanup?.maxTabsPerProfile ?? defaultConfig.browser?.cleanup?.maxTabsPerProfile,
        snapshotTtlMinutes: config.browser?.cleanup?.snapshotTtlMinutes ?? defaultConfig.browser?.cleanup?.snapshotTtlMinutes,
      },
      shutdown: {
        gracefulTimeoutMs: config.browser?.shutdown?.gracefulTimeoutMs ?? defaultConfig.browser?.shutdown?.gracefulTimeoutMs,
        forceKillTimeoutMs: config.browser?.shutdown?.forceKillTimeoutMs ?? defaultConfig.browser?.shutdown?.forceKillTimeoutMs,
      },
      profiles: config.browser?.profiles ?? defaultConfig.browser?.profiles ?? {},
    },
  };

  // Expand ~ home directory symbol in profilesRoot
  const rawRoot = merged.browser.profilesRoot || "~/.my-agent/browser/profiles";
  const resolvedRoot = rawRoot.startsWith("~/")
    ? path.join(os.homedir(), rawRoot.slice(2))
    : path.resolve(rawRoot);
  merged.browser.profilesRoot = resolvedRoot;

  // Validate the merged browser configuration
  validateBrowserConfig(merged.browser);

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
      browser: merged.permissions.browser,
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
