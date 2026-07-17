import path from "node:path";

export const agentDir = path.resolve(__dirname, "..", "..");
export const repoDir = path.resolve(agentDir, "..");
export const skillsDir = path.join(repoDir, "skills");
export const dataDir = path.join(agentDir, "data");
export const artifactDir = path.join(dataDir, "artifacts");
export const logDir = path.join(agentDir, "logs");
export const stateFile = path.join(logDir, "telegram-state.json");
export const botLog = path.join(logDir, "agent.log");
export const aiInteractionDir = path.join(logDir, "ai-interactions");
export const aiInteractionIndex = path.join(aiInteractionDir, "index.jsonl");
export const commandsFile = process.env.AGENT_COMMANDS_FILE
  ? path.resolve(process.env.AGENT_COMMANDS_FILE)
  : path.join(agentDir, "commands.json");
export const configFile = process.env.AGENT_CONFIG_FILE
  ? path.resolve(process.env.AGENT_CONFIG_FILE)
  : path.join(agentDir, "config.json");
export const systemPromptFile = path.join(agentDir, "prompts", "system.md");
export const memoryFile = path.join(agentDir, "prompts", "MEMORY.md");
export const sqliteFile = process.env.AGENT_DB_FILE
  ? path.resolve(process.env.AGENT_DB_FILE)
  : path.join(dataDir, "agent.sqlite");
