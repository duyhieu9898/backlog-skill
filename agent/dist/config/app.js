"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadAgentConfig = loadAgentConfig;
exports.loadSystemPrompt = loadSystemPrompt;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("./paths");
const apps_1 = require("../tools/computer/apps");
const DEFAULT_BROWSER_PERMISSIONS = {
    allowedHosts: [],
    publicNavigation: "allow",
    privateNavigation: "deny",
    consequentialActions: "confirm",
    destructiveActions: "confirm",
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
        timezone: "Asia/Ho_Chi_Minh",
        locale: "vi-VN",
    },
    schedules: [],
    desktop: {
        apps: [],
    },
    permissions: {
        workspaceRoot: paths_1.repoDir,
        allowedReadRoots: [paths_1.repoDir],
        allowedWriteRoots: [paths_1.agentDir, paths_1.skillsDir],
        deniedPaths: ["/etc", "/usr", "/bin", "/boot", "/proc", "/sys", "/dev"],
        browser: DEFAULT_BROWSER_PERMISSIONS,
    },
};
function loadAgentConfig() {
    if (!node_fs_1.default.existsSync(paths_1.configFile))
        return defaultConfig;
    const config = JSON.parse(node_fs_1.default.readFileSync(paths_1.configFile, "utf8"));
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
    };
    const resolveFromAgent = (candidate) => node_path_1.default.isAbsolute(candidate) ? candidate : node_path_1.default.resolve(paths_1.agentDir, candidate);
    const desktopApps = new apps_1.DesktopRegistry(merged.desktop.apps || []).list();
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
    if (node_fs_1.default.existsSync(paths_1.memoryFile)) {
        const memory = node_fs_1.default.readFileSync(paths_1.memoryFile, "utf8").trim();
        if (memory) {
            basePrompt += `\n\n# LONG-TERM MEMORY (Ký ức dài hạn)\nBên dưới là các thông tin dài hạn quan trọng về Preferences, Rules đặc thù được lưu trữ từ các phiên trò chuyện trước. Hãy luôn tuân thủ các thông tin này:\n\n${memory}`;
        }
    }
    return basePrompt;
}
