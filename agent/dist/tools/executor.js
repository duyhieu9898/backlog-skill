"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolExecutor = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const commands_1 = require("../commands");
const files_1 = require("./files");
const adapter_1 = require("../desktop/adapter");
const store_1 = require("../artifacts/store");
const events_1 = require("../desktop/events");
const permissionPolicy_1 = require("../security/permissionPolicy");
const app_1 = require("../config/app");
const node_fs_1 = __importDefault(require("node:fs"));
const schema_1 = require("./schema");
const emptyObjectSchema = {
    type: "object",
    properties: {},
    additionalProperties: false,
};
const fileDefinitions = [
    {
        name: "file.read",
        description: "Read a policy-allowed UTF-8 text file with bounded output.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                maxBytes: { type: "integer", minimum: 1, maximum: 1048576 },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "file.list",
        description: "List policy-visible entries in a directory.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                maxEntries: { type: "integer", minimum: 1, maximum: 2000 },
            },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "file.exists",
        description: "Check whether a policy-allowed path exists.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "file.mkdir",
        description: "Create a directory after explicit confirmation.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", minLength: 1, maxLength: 4096 } },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "file.write",
        description: "Atomically write bounded UTF-8 text after explicit confirmation.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                content: { type: "string", maxLength: 1048576 },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
    },
    {
        name: "file.patch",
        description: "Replace one exact text match after explicit confirmation.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", minLength: 1, maxLength: 4096 },
                search: { type: "string", minLength: 1, maxLength: 1048576 },
                replacement: { type: "string", maxLength: 1048576 },
            },
            required: ["path", "search", "replacement"],
            additionalProperties: false,
        },
    },
];
const desktopDefinitions = [
    { name: "desktop.capture", description: "Capture one approved display after explicit confirmation.", inputSchema: { type: "object", properties: { displayId: { type: "string", minLength: 1, maxLength: 128 } }, additionalProperties: false } },
    { name: "desktop.launch", description: "Launch one reviewed desktop app ID after explicit confirmation.", inputSchema: { type: "object", properties: { appId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["appId"], additionalProperties: false } },
];
function digest(value) {
    return node_crypto_1.default.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function truncate(value, max = 4000) {
    return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}
function fileAction(call) {
    return { kind: call.name, ...call.arguments };
}
function desktopAction(call) {
    return { kind: call.name, ...call.arguments };
}
class ToolExecutor {
    files;
    catalogLoader;
    constructor(files = new files_1.FileTools(), catalogLoader = commands_1.loadCommandCatalog) {
        this.files = files;
        this.catalogLoader = catalogLoader;
    }
    definitions(scope) {
        const commands = scope?.skillSlug
            ? this.catalogLoader().allow.filter((command) => command.skillSlug === scope.skillSlug)
            : scope
                ? []
                : this.catalogLoader().allow;
        const commandDefinitions = commands.map((command) => ({
            name: `command.${command.name}`,
            description: `${command.label}. Fixed argv; ${command.requiresConfirmation || command.externalSideEffect
                ? "requires explicit confirmation"
                : "may run without confirmation"}.`,
            inputSchema: command.inputSchema || emptyObjectSchema,
        }));
        const files = scope && !scope.includeFileTools ? [] : fileDefinitions;
        return [...files, ...commandDefinitions, ...desktopDefinitions].sort((a, b) => a.name.localeCompare(b.name));
    }
    prepare(call, traceId, definitions = this.definitions()) {
        const definition = definitions.find((tool) => tool.name === call.name);
        if (!definition)
            throw new Error(`Unknown tool: ${call.name}`);
        const errors = (0, schema_1.validateJsonSchema)(definition.inputSchema, call.arguments, "arguments");
        if (errors.length)
            throw new Error(`Invalid tool arguments for ${call.name}: ${errors.join(" ")}`);
        if (call.name.startsWith("command.")) {
            const commandName = call.name.slice("command.".length);
            const base = this.catalogLoader().allow.find((command) => command.name === commandName);
            if (!base)
                throw new Error(`Unknown allowlisted command: ${commandName}`);
            const command = base.inputSchema ? (0, commands_1.withCommandInput)(base, call.arguments) : base;
            const decision = (0, commands_1.evaluateCommandPermission)(command);
            const preview = (0, commands_1.previewCommand)(command);
            const commandDigest = (0, commands_1.commandPreviewDigest)(preview);
            if (decision.outcome === "deny") {
                return {
                    call,
                    key: commandName,
                    digest: commandDigest,
                    preview: decision.reason,
                    requiresConfirmation: false,
                    command,
                    blocked: { ok: false, code: decision.reasonCode, summary: decision.reason },
                };
            }
            const inputPreview = command.invocationInput === undefined
                ? []
                : [`Input: ${truncate(JSON.stringify(command.invocationInput))}`];
            return {
                call,
                key: commandName,
                digest: commandDigest,
                requiresConfirmation: decision.outcome === "confirm",
                command,
                preview: [
                    command.label,
                    `Executable: ${preview.executable}`,
                    `Args: ${JSON.stringify(preview.args)}`,
                    ...inputPreview,
                    `Cwd: ${preview.cwd}`,
                    `Timeout: ${preview.timeoutMs} ms`,
                ].join("\n"),
            };
        }
        if (call.name.startsWith("desktop.")) {
            const action = desktopAction(call);
            const adapter = (0, adapter_1.getDesktopAdapter)();
            const config = (0, app_1.loadAgentConfig)();
            const decision = new permissionPolicy_1.PermissionPolicy(config.permissions).evaluate(action, { desktopStatus: adapter.getStatus() });
            const actionDigest = digest(action);
            if (decision.outcome === "deny")
                return { call, key: call.name, digest: actionDigest, preview: decision.reason, requiresConfirmation: false, desktopAction: action, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
            return { call, key: call.name, digest: actionDigest, preview: `${call.name}: ${JSON.stringify(call.arguments)}`, requiresConfirmation: decision.outcome === "confirm", desktopAction: action };
        }
        const action = fileAction(call);
        const actionDigest = digest(action);
        const requiresConfirmation = ["file.mkdir", "file.write", "file.patch"].includes(call.name);
        let preview = `${call.name}: ${call.arguments.path || ""}`;
        if (requiresConfirmation) {
            const result = this.files.execute(action, { traceId });
            if (result.code !== "CONFIRMATION_REQUIRED") {
                return {
                    call,
                    key: call.name,
                    digest: actionDigest,
                    preview: result.summary,
                    requiresConfirmation: false,
                    fileAction: action,
                    blocked: result,
                };
            }
            preview = truncate(JSON.stringify(result.data, null, 2));
        }
        return {
            call,
            key: call.name,
            digest: actionDigest,
            preview,
            requiresConfirmation,
            fileAction: action,
        };
    }
    async execute(prepared, input) {
        if (prepared.blocked)
            return prepared.blocked;
        if (prepared.command) {
            try {
                const result = await (0, commands_1.runTrackedCommand)({
                    traceId: input.traceId,
                    chatId: input.chatId,
                    action: prepared.command,
                    confirmationGranted: input.confirmationGranted,
                });
                const ok = result.exitCode === 0 && !result.signal;
                return {
                    ok,
                    code: ok ? "COMMAND_COMPLETED" : "COMMAND_FAILED",
                    summary: ok ? `${prepared.command.label} completed.` : `${prepared.command.label} failed.`,
                    data: {
                        exitCode: result.exitCode,
                        signal: result.signal,
                        timedOut: result.timedOut,
                        output: truncate(result.output, 16 * 1024),
                    },
                };
            }
            catch (error) {
                return { ok: false, code: "COMMAND_ERROR", summary: error instanceof Error ? error.message : String(error) };
            }
        }
        if (prepared.desktopAction) {
            const adapter = (0, adapter_1.getDesktopAdapter)();
            const config = (0, app_1.loadAgentConfig)();
            const decision = new permissionPolicy_1.PermissionPolicy(config.permissions).evaluate(prepared.desktopAction, { desktopStatus: adapter.getStatus(), confirmationGranted: input.confirmationGranted });
            if (decision.outcome !== "allow")
                return { ok: false, code: decision.reasonCode, summary: decision.reason };
            try {
                if (prepared.desktopAction.kind === "desktop.capture") {
                    if (!("capture" in adapter) || typeof adapter.capture !== "function")
                        throw new Error("Desktop adapter cannot capture.");
                    const captured = adapter.capture(prepared.desktopAction.displayId);
                    const artifact = new store_1.ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: node_fs_1.default.readFileSync(captured.path) });
                    node_fs_1.default.rmSync(captured.path, { force: true });
                    (0, events_1.logDesktopEvent)(input.traceId, { component: "desktop", action: "screen.capture", outcome: "completed", artifactId: artifact.id });
                    return { ok: true, code: "DESKTOP_CAPTURED", summary: "Screen captured.", data: { artifactId: artifact.id } };
                }
                if (prepared.desktopAction.kind === "desktop.launch") {
                    if (!("launch" in adapter) || typeof adapter.launch !== "function")
                        throw new Error("Desktop adapter cannot launch apps.");
                    const launched = adapter.launch(prepared.desktopAction.appId);
                    (0, events_1.logDesktopEvent)(input.traceId, { component: "desktop", action: "app.launch", outcome: "completed" });
                    return { ok: true, code: "DESKTOP_LAUNCHED", summary: `Launched ${launched.appId}.`, data: launched };
                }
            }
            catch (error) {
                (0, events_1.logDesktopEvent)(input.traceId, { component: "desktop", action: prepared.desktopAction.kind, outcome: "failed", reasonCode: "DESKTOP_ACTION_FAILED" });
                return { ok: false, code: "DESKTOP_ACTION_FAILED", summary: error instanceof Error ? error.message : String(error) };
            }
        }
        if (!prepared.fileAction)
            throw new Error("Prepared tool call has no executable action.");
        return this.files.execute(prepared.fileAction, {
            traceId: input.traceId,
            confirmationGranted: input.confirmationGranted,
        });
    }
}
exports.ToolExecutor = ToolExecutor;
