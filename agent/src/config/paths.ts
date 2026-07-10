import path from "node:path";

export const agentDir = path.resolve(__dirname, "..", "..");
export const repoDir = path.resolve(agentDir, "..");
export const skillsDir = path.join(repoDir, "skills");
export const dataDir = path.join(agentDir, "data");
export const logDir = path.join(agentDir, "logs");
export const stateFile = path.join(logDir, "telegram-state.json");
export const botLog = path.join(logDir, "agent.log");
export const aiInteractionDir = path.join(logDir, "ai-interactions");
export const aiInteractionIndex = path.join(aiInteractionDir, "index.jsonl");
export const commandsFile = path.join(agentDir, "commands.json");
export const configFile = path.join(agentDir, "config.json");
export const systemPromptFile = path.join(agentDir, "prompts", "system.md");
export const sqliteFile = path.join(dataDir, "agent.sqlite");
