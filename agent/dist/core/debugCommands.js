"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatLastRun = formatLastRun;
exports.formatLastCommandError = formatLastCommandError;
exports.formatToolError = formatToolError;
exports.isDebugCommand = isDebugCommand;
exports.handleDebugCommand = handleDebugCommand;
const commands_1 = require("../commands");
const paths_1 = require("../config/paths");
const repositories_1 = require("../storage/repositories");
const scheduler_1 = require("../scheduler");
const computer_1 = require("../tools/computer");
const app_1 = require("../config/app");
const startedAt = Date.now();
function formatLastRun(run) {
    if (!run)
        return "No command runs yet.";
    return [
        `${run.status.toUpperCase()} ${run.label}`,
        `traceId: ${run.trace_id}`,
        `finished: ${run.finished_at || "-"}`,
        `exit: ${run.exit_code ?? "-"}`,
        "",
        run.output_tail || run.error_message || "(no output)",
    ].join("\n");
}
function formatLastCommandError(run) {
    if (!run)
        return "No failed command or tool runs yet.";
    return [
        `FAILED ${run.label}`,
        `traceId: ${run.trace_id}`,
        `finished: ${run.finished_at || "-"}`,
        `error: ${run.error_message || "-"}`,
        "",
        run.output_tail || "(no output)",
    ].join("\n");
}
function formatToolError(tool) {
    return [
        `FAILED TOOL ${tool.event}`,
        `traceId: ${tool.trace_id}`,
        `at: ${tool.created_at}`,
        "",
        JSON.stringify(JSON.parse(tool.payload_json), null, 2),
    ].join("\n");
}
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours)
        return `${hours}h ${minutes % 60}m`;
    if (minutes)
        return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}
function isDebugCommand(text) {
    const normalized = text.trim().toLowerCase();
    return (normalized === "/status" ||
        normalized === "/last" ||
        normalized === "/last-error" ||
        normalized === "/debug" ||
        normalized.startsWith("/debug ") ||
        normalized === "/commands" ||
        normalized === "/schedule" ||
        normalized === "/skills" ||
        normalized === "/desktop" ||
        normalized === "/help" ||
        normalized === "help");
}
function handleDebugCommand(text, registry) {
    const normalized = text.trim().toLowerCase();
    const catalog = (0, commands_1.loadCommandCatalog)();
    if (normalized === "/help" || normalized === "help") {
        return [
            "My agents",
            "",
            "/status - runtime status",
            "/last - last command result",
            "/last-error - latest failed command",
            "/stop - stop the currently running command",
            "/debug <traceId> - raw trace events",
            "/commands - command aliases grouped by skill",
            "/schedule - configured scheduled checks",
            "/schedule show <name> - schedule details",
            "/schedule history <name> - recent scheduled runs",
            "/schedule run <name> - run one scheduled check now",
            "/schedule enable|disable <name> - change state after confirmation",
            "/schedule interval <name> <minutes> - change interval after confirmation",
            "/skills - scanned skills",
            "/desktop - desktop capability and permission status",
            "",
            "Command aliases:",
            formatCommands(catalog.allow),
        ].join("\n");
    }
    if (normalized === "/commands") {
        return formatCommands(catalog.allow);
    }
    if (normalized === "/schedule") {
        return (0, scheduler_1.formatScheduleList)((0, scheduler_1.loadScheduledChecks)());
    }
    if (normalized === "/skills") {
        const skills = registry.listSkills();
        const errors = registry.listErrors();
        const loaded = skills.length
            ? skills
                .map((skill) => `${skill.slug} - ${skill.name}\n${skill.description}`)
                .join("\n\n")
            : "No skills loaded.";
        if (!errors.length)
            return loaded;
        return [
            loaded,
            "Registry errors:",
            ...errors.map((error) => `- ${error.slug}: ${error.message}`),
        ].join("\n\n");
    }
    if (normalized === "/desktop") {
        const status = (0, computer_1.getDesktopAdapter)().getStatus();
        const registry = new computer_1.DesktopRegistry((0, app_1.loadAgentConfig)().desktop?.apps || []);
        return [
            `platform: ${status.platform}`,
            ...status.capabilities.map((entry) => `${entry.capability}: ${entry.available ? "available" : "unavailable"} (${entry.permission.state})`),
            `displays: ${status.displays.length}`,
            `declared apps: ${registry.list().length}`,
        ].join("\n");
    }
    if (normalized === "/status") {
        const currentRun = (0, repositories_1.getJsonState)("runtime_state", "currentRun");
        const lastScheduledRun = (0, repositories_1.getJsonState)("runtime_state", "lastScheduledRun");
        return [
            "Status",
            `uptime: ${formatDuration(Date.now() - startedAt)}`,
            `current: ${currentRun ? JSON.stringify(currentRun) : "none"}`,
            `last scheduled: ${lastScheduledRun ? JSON.stringify(lastScheduledRun) : "none"}`,
            `pending confirmations: ${(0, repositories_1.countPendingConfirmations)()}`,
            `loaded commands: ${catalog.allow.length}`,
            `loaded skills: ${registry.listSkills().length}`,
            `skill registry errors: ${registry.listErrors().length}`,
            ...registry.listErrors().map((error) => `- ${error.slug}: ${error.message}`),
            `sqlite: ${paths_1.sqliteFile}`,
        ].join("\n");
    }
    if (normalized === "/last") {
        return formatLastRun((0, repositories_1.getLastCommandRun)());
    }
    if (normalized === "/last-error") {
        const run = (0, repositories_1.getLastFailedCommandRun)();
        const tool = (0, repositories_1.getLastFailedToolEvent)();
        if (tool && (!run?.finished_at || tool.created_at > run.finished_at)) {
            return formatToolError(tool);
        }
        return formatLastCommandError(run);
    }
    if (normalized === "/debug") {
        return "Usage: /debug <traceId>";
    }
    if (normalized.startsWith("/debug ")) {
        const traceId = text.trim().split(/\s+/, 2)[1];
        const events = (0, repositories_1.listTraceEvents)(traceId, 50).map((row) => ({
            traceId: row.trace_id,
            event: row.event,
            payload: JSON.parse(row.payload_json),
            createdAt: row.created_at,
        }));
        return JSON.stringify(events, null, 2);
    }
    return "Unsupported debug command.";
}
function formatCommands(commands) {
    if (!commands.length)
        return "No commands configured.";
    const grouped = new Map();
    for (const command of commands) {
        const group = command.skillSlug || "general";
        const aliases = command.aliases?.length ? ` (${command.aliases.join(", ")})` : "";
        const confirmation = command.requiresConfirmation ? " confirm" : " direct";
        const line = `${command.name || command.label}${aliases} - ${command.label} [${confirmation}]`;
        grouped.set(group, [...(grouped.get(group) || []), line]);
    }
    return [...grouped.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([group, lines]) => `${group}\n${lines.sort().map((line) => `- ${line}`).join("\n")}`)
        .join("\n\n");
}
