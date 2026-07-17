"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BROWSER_RESOURCE_CONFIG = void 0;
exports.loadAgentConfig = loadAgentConfig;
exports.loadSystemPrompt = loadSystemPrompt;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const node_os_1 = __importDefault(require("node:os"));
const paths_1 = require("./paths");
const apps_1 = require("../tools/computer/apps");
const DEFAULT_BROWSER_PERMISSIONS = {
    allowedHosts: [],
    publicNavigation: "allow",
    privateNavigation: "allow",
    consequentialActions: "confirm",
    destructiveActions: "confirm",
};
exports.DEFAULT_BROWSER_RESOURCE_CONFIG = {
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
const defaultConfig = {
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
        runDeadlineMs: 30 * 60 * 1000,
        timezone: "Asia/Ho_Chi_Minh",
        locale: "vi-VN",
    },
    context: {
        maxContextTokens: 128_000,
        reserveTokens: 20_000,
        recentTailTokens: 20_000,
        summaryMaxTokens: 6_000,
        retrievedMemoryMaxTokens: 3_000,
        toolResultSoftTrimChars: 4_000,
        keepRecentAssistantTurnsFromPruning: 3,
    },
    logging: {
        rawAiInteractions: true,
        rawAiRetentionDays: 14,
        traceRetentionDays: 30,
    },
    schedules: [],
    desktop: {
        apps: [],
    },
    permissions: {
        browser: DEFAULT_BROWSER_PERMISSIONS,
    },
    browser: exports.DEFAULT_BROWSER_RESOURCE_CONFIG,
};
function validateBrowserConfig(browser) {
    if (!browser)
        return;
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
        if (!node_path_1.default.isAbsolute(profilesRoot)) {
            throw new Error("Invalid config: profilesRoot must resolve to an absolute path");
        }
    }
    if (profiles) {
        for (const [name, profileSpec] of Object.entries(profiles)) {
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
function loadAgentConfig() {
    let config = {};
    if (node_fs_1.default.existsSync(paths_1.configFile)) {
        try {
            config = JSON.parse(node_fs_1.default.readFileSync(paths_1.configFile, "utf8"));
        }
        catch (e) {
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
        context: {
            ...defaultConfig.context,
            ...config.context,
        },
        logging: {
            ...defaultConfig.logging,
            ...config.logging,
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
    if (typeof merged.runtime.runDeadlineMs === "number" && merged.runtime.runDeadlineMs <= 0) {
        throw new Error("Invalid config: runtime.runDeadlineMs must be positive");
    }
    if (!merged.context || merged.context.maxContextTokens <= merged.context.reserveTokens) {
        throw new Error("Invalid config: context.maxContextTokens must exceed reserveTokens");
    }
    if (merged.context.recentTailTokens <= 0 || merged.context.summaryMaxTokens <= 0 || merged.context.retrievedMemoryMaxTokens < 0) {
        throw new Error("Invalid config: context token budgets must be positive (memory may be zero)");
    }
    // Expand ~ home directory symbol in profilesRoot
    const rawRoot = merged.browser.profilesRoot || "~/.my-agent/browser/profiles";
    const resolvedRoot = rawRoot.startsWith("~/")
        ? node_path_1.default.join(node_os_1.default.homedir(), rawRoot.slice(2))
        : node_path_1.default.resolve(rawRoot);
    merged.browser.profilesRoot = resolvedRoot;
    // Validate the merged browser configuration
    validateBrowserConfig(merged.browser);
    const desktopApps = new apps_1.DesktopRegistry(merged.desktop.apps || []).list();
    return {
        ...merged,
        desktop: {
            ...merged.desktop,
            apps: desktopApps,
        },
        permissions: {
            ...merged.permissions,
            desktopAppIds: desktopApps.map((app) => app.id),
            browser: merged.permissions.browser,
        },
    };
}
function loadSystemPrompt() {
    let basePrompt = "";
    if (!node_fs_1.default.existsSync(paths_1.systemPromptFile)) {
        basePrompt = [
            "You are a local Telegram agent orchestrator.",
            "Choose only allowed commands when command execution is needed.",
            "Reply concisely in the user's language.",
        ].join("\n");
    }
    else {
        basePrompt = node_fs_1.default.readFileSync(paths_1.systemPromptFile, "utf8");
    }
    return basePrompt;
}
