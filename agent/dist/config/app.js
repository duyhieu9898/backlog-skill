"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadAgentConfig = loadAgentConfig;
exports.loadSystemPrompt = loadSystemPrompt;
const node_fs_1 = __importDefault(require("node:fs"));
const paths_1 = require("./paths");
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
    },
};
function loadAgentConfig() {
    if (!node_fs_1.default.existsSync(paths_1.configFile))
        return defaultConfig;
    const config = JSON.parse(node_fs_1.default.readFileSync(paths_1.configFile, "utf8"));
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
function loadSystemPrompt() {
    if (!node_fs_1.default.existsSync(paths_1.systemPromptFile)) {
        return [
            "You are a local Telegram agent orchestrator.",
            "Choose only allowed commands when command execution is needed.",
            "Reply concisely in the user's language.",
        ].join("\n");
    }
    return node_fs_1.default.readFileSync(paths_1.systemPromptFile, "utf8");
}
