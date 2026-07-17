"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sqliteFile = exports.memoryFile = exports.systemPromptFile = exports.configFile = exports.commandsFile = exports.aiInteractionIndex = exports.aiInteractionDir = exports.botLog = exports.stateFile = exports.logDir = exports.artifactDir = exports.dataDir = exports.skillsDir = exports.repoDir = exports.agentDir = void 0;
const node_path_1 = __importDefault(require("node:path"));
exports.agentDir = node_path_1.default.resolve(__dirname, "..", "..");
exports.repoDir = node_path_1.default.resolve(exports.agentDir, "..");
exports.skillsDir = node_path_1.default.join(exports.repoDir, "skills");
exports.dataDir = node_path_1.default.join(exports.agentDir, "data");
exports.artifactDir = node_path_1.default.join(exports.dataDir, "artifacts");
exports.logDir = node_path_1.default.join(exports.agentDir, "logs");
exports.stateFile = node_path_1.default.join(exports.logDir, "telegram-state.json");
exports.botLog = node_path_1.default.join(exports.logDir, "agent.log");
exports.aiInteractionDir = node_path_1.default.join(exports.logDir, "ai-interactions");
exports.aiInteractionIndex = node_path_1.default.join(exports.aiInteractionDir, "index.jsonl");
exports.commandsFile = process.env.AGENT_COMMANDS_FILE
    ? node_path_1.default.resolve(process.env.AGENT_COMMANDS_FILE)
    : node_path_1.default.join(exports.agentDir, "commands.json");
exports.configFile = process.env.AGENT_CONFIG_FILE
    ? node_path_1.default.resolve(process.env.AGENT_CONFIG_FILE)
    : node_path_1.default.join(exports.agentDir, "config.json");
exports.systemPromptFile = node_path_1.default.join(exports.agentDir, "prompts", "system.md");
exports.memoryFile = node_path_1.default.join(exports.agentDir, "prompts", "MEMORY.md");
exports.sqliteFile = process.env.AGENT_DB_FILE
    ? node_path_1.default.resolve(process.env.AGENT_DB_FILE)
    : node_path_1.default.join(exports.dataDir, "agent.sqlite");
