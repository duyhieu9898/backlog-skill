"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isDebugCommand = isDebugCommand;
exports.handleDebugCommand = handleDebugCommand;
const commands_1 = require("../commands");
const paths_1 = require("../config/paths");
const repositories_1 = require("../storage/repositories");
const startedAt = Date.now();
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
        normalized.startsWith("/debug ") ||
        normalized === "/commands" ||
        normalized === "/skills" ||
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
            "/debug <traceId> - raw trace events",
            "/commands - command aliases grouped by skill",
            "/skills - scanned skills",
            "",
            "Command aliases:",
            formatCommands(catalog.allow),
        ].join("\n");
    }
    if (normalized === "/commands") {
        return formatCommands(catalog.allow);
    }
    if (normalized === "/skills") {
        const skills = registry.listSkills();
        if (!skills.length)
            return "No skills loaded.";
        return skills
            .map((skill) => `${skill.slug} - ${skill.name}\n${skill.description}`)
            .join("\n\n");
    }
    if (normalized === "/status") {
        const currentRun = (0, repositories_1.getJsonState)("runtime_state", "currentRun");
        return [
            "Status",
            `uptime: ${formatDuration(Date.now() - startedAt)}`,
            `current: ${currentRun ? JSON.stringify(currentRun) : "none"}`,
            `pending confirmations: ${(0, repositories_1.countPendingConfirmations)()}`,
            `loaded commands: ${catalog.allow.length}`,
            `sqlite: ${paths_1.sqliteFile}`,
        ].join("\n");
    }
    if (normalized === "/last") {
        const run = (0, repositories_1.getLastCommandRun)();
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
    if (normalized === "/last-error") {
        const run = (0, repositories_1.getLastFailedCommandRun)();
        if (!run)
            return "No failed command runs yet.";
        return [
            `FAILED ${run.label}`,
            `traceId: ${run.trace_id}`,
            `finished: ${run.finished_at || "-"}`,
            `error: ${run.error_message || "-"}`,
            "",
            run.output_tail || "(no output)",
        ].join("\n");
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
