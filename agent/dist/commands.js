"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadCommands = loadCommands;
exports.loadCommandCatalog = loadCommandCatalog;
exports.buildCommandCatalog = buildCommandCatalog;
exports.resolveCwd = resolveCwd;
exports.evaluateCommandPermission = evaluateCommandPermission;
exports.isCommandRunning = isCommandRunning;
exports.getRunningTraceId = getRunningTraceId;
exports.buildCommandEnvironment = buildCommandEnvironment;
exports.previewCommand = previewCommand;
exports.commandPreviewDigest = commandPreviewDigest;
exports.runTrackedCommand = runTrackedCommand;
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = __importDefault(require("node:crypto"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const paths_1 = require("./config/paths");
const logger_1 = require("./logging/logger");
const repositories_1 = require("./storage/repositories");
const utils_1 = require("./utils");
const app_1 = require("./config/app");
const permissionPolicy_1 = require("./security/permissionPolicy");
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const SAFE_ENV_KEYS = [
    "HOME",
    "LANG",
    "LC_ALL",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
];
let runningTraceId = null;
function normalizeCommand(action) {
    if (!action.name?.trim())
        throw new Error("Allowlisted command is missing a name.");
    if (!action.label?.trim())
        throw new Error(`Allowlisted command ${action.name} is missing a label.`);
    if (!Array.isArray(action.argv) || !action.argv.length) {
        throw new Error(`Allowlisted command ${action.name} must define a non-empty argv array.`);
    }
    for (const value of action.argv) {
        if (typeof value !== "string" || !value || value.includes("\0")) {
            throw new Error(`Allowlisted command ${action.name} has an invalid argv value.`);
        }
    }
    const cwd = resolveCwd(action.cwd);
    if (!node_fs_1.default.existsSync(cwd) || !node_fs_1.default.statSync(cwd).isDirectory()) {
        throw new Error(`Allowlisted command ${action.name} has a stale cwd: ${cwd}`);
    }
    if (action.skillSlug) {
        const skillRoot = node_path_1.default.resolve(paths_1.agentDir, "..", "skills", action.skillSlug);
        if (!node_fs_1.default.existsSync(node_path_1.default.join(skillRoot, "SKILL.md"))) {
            throw new Error(`Allowlisted command ${action.name} references missing skill: ${action.skillSlug}`);
        }
        if (cwd !== node_fs_1.default.realpathSync(skillRoot)) {
            throw new Error(`Allowlisted command ${action.name} cwd does not match skill ${action.skillSlug}.`);
        }
    }
    return {
        ...action,
        cwd,
        requiresConfirmation: action.requiresConfirmation ?? true,
        externalSideEffect: action.externalSideEffect ?? false,
    };
}
function loadCommands() {
    return loadCommandCatalog().byAlias;
}
function loadCommandCatalog() {
    const config = JSON.parse(node_fs_1.default.readFileSync(paths_1.commandsFile, "utf8"));
    return buildCommandCatalog(config);
}
function buildCommandCatalog(config) {
    if (config.allow) {
        const allow = config.allow.map(normalizeCommand);
        const byAlias = allow.reduce((commands, action) => {
            const names = [action.name, ...(action.aliases || [])].filter(Boolean);
            for (const name of names) {
                const key = name.toLowerCase();
                if (commands[key])
                    throw new Error(`Duplicate command name or alias: ${name}`);
                commands[key] = action;
            }
            return commands;
        }, {});
        return { byAlias, allow };
    }
    throw new Error("commands.json must define an allow array using argv-based commands.");
}
function resolveCwd(cwd) {
    if (!cwd)
        return paths_1.agentDir;
    return node_path_1.default.isAbsolute(cwd) ? cwd : node_path_1.default.resolve(paths_1.agentDir, cwd);
}
function evaluateCommandPermission(action, confirmationGranted = false) {
    const config = (0, app_1.loadAgentConfig)().permissions;
    const policy = new permissionPolicy_1.PermissionPolicy(config);
    return policy.evaluate({
        kind: "command.run",
        commandId: action.name || action.label,
        executable: action.argv[0],
        args: action.argv.slice(1),
        cwd: resolveCwd(action.cwd),
        requiresConfirmation: action.requiresConfirmation ?? true,
        externalSideEffect: action.externalSideEffect ?? false,
    }, { confirmationGranted });
}
function isCommandRunning() {
    return runningTraceId !== null;
}
function getRunningTraceId() {
    return runningTraceId;
}
function buildCommandEnvironment(source = process.env) {
    const env = {};
    for (const key of SAFE_ENV_KEYS) {
        if (source[key] !== undefined)
            env[key] = source[key];
    }
    env.PATH ||= "/usr/local/bin:/usr/bin:/bin";
    return env;
}
function previewCommand(action, defaultTimeoutMs = DEFAULT_TIMEOUT_MS) {
    return {
        commandName: action.name || action.label,
        label: action.label,
        executable: action.argv[0],
        args: action.argv.slice(1),
        cwd: resolveCwd(action.cwd),
        timeoutMs: Number(action.timeoutMs || defaultTimeoutMs),
        requiresConfirmation: action.requiresConfirmation ?? true,
        externalSideEffect: action.externalSideEffect ?? false,
    };
}
function commandPreviewDigest(preview) {
    const canonical = JSON.stringify({
        commandName: preview.commandName,
        label: preview.label,
        executable: preview.executable,
        args: preview.args,
        cwd: preview.cwd,
        timeoutMs: preview.timeoutMs,
        requiresConfirmation: preview.requiresConfirmation,
        externalSideEffect: preview.externalSideEffect,
    });
    return node_crypto_1.default.createHash("sha256").update(canonical).digest("hex");
}
function runCommand(action, defaultTimeoutMs) {
    return new Promise((resolve, reject) => {
        const preview = previewCommand(action, defaultTimeoutMs);
        const child = (0, node_child_process_1.spawn)(preview.executable, preview.args, {
            cwd: preview.cwd,
            env: buildCommandEnvironment(),
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const chunks = [];
        let outputBytes = 0;
        let outputLimited = false;
        let timedOut = false;
        let settled = false;
        const capture = (chunk) => {
            if (outputLimited)
                return;
            const remaining = MAX_OUTPUT_BYTES - outputBytes;
            if (chunk.length > remaining) {
                if (remaining > 0)
                    chunks.push(chunk.subarray(0, remaining));
                chunks.push(Buffer.from("\n[output truncated: command exceeded 10 MiB]"));
                outputLimited = true;
                child.kill("SIGTERM");
                return;
            }
            chunks.push(chunk);
            outputBytes += chunk.length;
        };
        child.stdout.on("data", capture);
        child.stderr.on("data", capture);
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, preview.timeoutMs);
        child.once("error", (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (code, signal) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                exitCode: timedOut ? 124 : code ?? (signal ? 1 : 0),
                signal: signal || undefined,
                output: Buffer.concat(chunks).toString("utf8"),
                timedOut,
            });
        });
    });
}
async function runTrackedCommand(input) {
    if (runningTraceId) {
        throw new Error(`Command already running for trace ${runningTraceId}`);
    }
    const action = normalizeCommand(input.action);
    const policyDecision = evaluateCommandPermission(action, input.confirmationGranted);
    if (policyDecision.outcome !== "allow") {
        throw new Error(`Permission ${policyDecision.outcome}: ${policyDecision.reasonCode} - ${policyDecision.reason}`);
    }
    if (policyDecision.action.kind !== "command.run") {
        throw new Error("Permission policy returned an invalid action kind for command execution.");
    }
    action.cwd = policyDecision.action.cwd;
    const cwd = action.cwd;
    const preview = previewCommand(action, input.defaultTimeoutMs || DEFAULT_TIMEOUT_MS);
    const command = JSON.stringify([preview.executable, ...preview.args]);
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
            timedOut: result.timedOut,
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
