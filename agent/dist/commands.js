"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCommands = loadCommands;
exports.loadCommandCatalog = loadCommandCatalog;
exports.resolveCwd = resolveCwd;
exports.isCommandRunning = isCommandRunning;
exports.getRunningTraceId = getRunningTraceId;
exports.validateWildcardRawCommand = validateWildcardRawCommand;
exports.runCommand = runCommand;
exports.runTrackedCommand = runTrackedCommand;
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("./config/paths");
const logger_1 = require("./logging/logger");
const repositories_1 = require("./storage/repositories");
const utils_1 = require("./utils");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
let runningTraceId = null;
function normalizeCommand(action) {
    return {
        ...action,
        requiresConfirmation: action.requiresConfirmation ?? true,
    };
}
function loadCommands() {
    return loadCommandCatalog().byAlias;
}
function loadCommandCatalog() {
    const config = JSON.parse(node_fs_1.default.readFileSync(paths_1.commandsFile, "utf8"));
    if (config.allow) {
        const allow = config.allow.map(normalizeCommand);
        const byAlias = allow.reduce((commands, action) => {
            const names = [action.name, ...(action.aliases || [])].filter(Boolean);
            for (const name of names) {
                commands[name.toLowerCase()] = action;
            }
            return commands;
        }, {});
        return { byAlias, allow };
    }
    const legacy = config.commands || {};
    return {
        byAlias: legacy,
        allow: Object.entries(legacy).map(([name, action]) => normalizeCommand({ ...action, name: action.name || name })),
    };
}
function resolveCwd(cwd) {
    if (!cwd)
        return paths_1.agentDir;
    return node_path_1.default.isAbsolute(cwd) ? cwd : node_path_1.default.resolve(paths_1.agentDir, cwd);
}
function isCommandRunning() {
    return runningTraceId !== null;
}
function getRunningTraceId() {
    return runningTraceId;
}
function validateWildcardRawCommand(rawCommand) {
    const denyPatterns = [
        /\bsudo\b/,
        /\bsu\b/,
        /\brm\s+-[^\n;|&]*r[^\n;|&]*f\s+\//,
        /\bmkfs(?:\.\w+)?\b/,
        /\bdd\s+/,
        /:\s*\(\)\s*\{/,
        />\s*\/(?:etc|usr|bin|boot)\b/,
        /\b(?:tee|cp|mv|install)\b[^\n;|&]*\/(?:etc|usr|bin|boot)\b/,
        /\b(?:curl|wget)\b[^\n;|&]*\|\s*(?:sh|bash|zsh|fish)\b/,
    ];
    for (const pattern of denyPatterns) {
        if (pattern.test(rawCommand)) {
            return { ok: false, reason: `Rejected by denylist pattern: ${pattern.source}` };
        }
    }
    return { ok: true };
}
function runCommand(action, defaultTimeoutMs) {
    return new Promise((resolve) => {
        (0, node_child_process_1.exec)(action.command, {
            cwd: resolveCwd(action.cwd),
            env: { ...process.env },
            shell: "/bin/bash",
            timeout: Number(action.timeoutMs || defaultTimeoutMs),
            maxBuffer: 1024 * 1024 * 10,
        }, (error, stdout, stderr) => {
            resolve({
                exitCode: typeof error?.code === "number" ? error.code : 0,
                signal: error?.signal || undefined,
                output: `${stdout || ""}${stderr || ""}`,
            });
        });
    });
}
async function runTrackedCommand(input) {
    if (runningTraceId) {
        throw new Error(`Command already running for trace ${runningTraceId}`);
    }
    const command = input.rawCommand || input.action.command;
    if (input.action.command === "*" && !input.rawCommand) {
        throw new Error("Wildcard command requires rawCommand.");
    }
    if (input.action.command === "*" && input.rawCommand) {
        const validation = validateWildcardRawCommand(input.rawCommand);
        if (!validation.ok) {
            throw new Error(`${validation.reason}. Run that command manually outside the bot.`);
        }
    }
    const action = { ...input.action, command };
    const cwd = resolveCwd(action.cwd);
    const startedAt = (0, repositories_1.nowIso)();
    runningTraceId = input.traceId;
    (0, repositories_1.setJsonState)("runtime_state", "currentRun", {
        traceId: input.traceId,
        chatId: input.chatId,
        label: action.label,
        skillSlug: action.skillSlug,
        command,
        startedAt,
    });
    (0, repositories_1.insertCommandRun)({
        traceId: input.traceId,
        chatId: input.chatId,
        commandName: action.name || action.label,
        label: action.label,
        cwd,
        command,
        startedAt,
    });
    logger_1.log.info(input.traceId, "command.started", {
        commandName: action.name,
        label: action.label,
        cwd,
    });
    try {
        const result = await runCommand(action, input.defaultTimeoutMs || DEFAULT_TIMEOUT_MS);
        const ok = result.exitCode === 0 && !result.signal;
        const finishedAt = (0, repositories_1.nowIso)();
        const outputTail = (0, utils_1.tailLines)(result.output, 80).slice(-4096);
        (0, repositories_1.finishCommandRun)({
            traceId: input.traceId,
            status: ok ? "success" : "failed",
            finishedAt,
            exitCode: result.exitCode,
            outputTail,
            errorMessage: ok ? undefined : `Exit ${result.exitCode || result.signal || "unknown"}`,
        });
        (0, repositories_1.setJsonState)("runtime_state", "lastRun", {
            traceId: input.traceId,
            label: action.label,
            status: ok ? "success" : "failed",
            finishedAt,
            outputTail,
        });
        if (!ok) {
            (0, repositories_1.setJsonState)("runtime_state", "lastError", {
                traceId: input.traceId,
                message: `Command failed: ${action.label}`,
                at: finishedAt,
            });
        }
        logger_1.log.info(input.traceId, ok ? "command.completed" : "command.failed", {
            exitCode: result.exitCode,
            signal: result.signal,
            outputTail,
        });
        return result;
    }
    catch (error) {
        const finishedAt = (0, repositories_1.nowIso)();
        const message = error instanceof Error ? error.message : String(error);
        (0, repositories_1.finishCommandRun)({
            traceId: input.traceId,
            status: "failed",
            finishedAt,
            exitCode: null,
            outputTail: "",
            errorMessage: message,
        });
        (0, repositories_1.setJsonState)("runtime_state", "lastError", {
            traceId: input.traceId,
            message,
            stack: error instanceof Error ? error.stack : undefined,
            at: finishedAt,
        });
        logger_1.log.error(input.traceId, "command.failed", { error });
        throw error;
    }
    finally {
        runningTraceId = null;
        (0, repositories_1.setJsonState)("runtime_state", "currentRun", null);
    }
}
