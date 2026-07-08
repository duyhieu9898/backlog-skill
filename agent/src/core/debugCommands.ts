import { loadCommandCatalog } from "../commands";
import { sqliteFile } from "../config/paths";
import {
  countPendingConfirmations,
  getJsonState,
  getLastCommandRun,
  getLastFailedCommandRun,
  getLastFailedToolEvent,
  listTraceEvents,
  type CommandRunRow,
  type TraceEventRow,
} from "../storage/repositories";
import type { SkillRegistry } from "../skills/registry";
import { formatScheduleList, loadScheduledChecks } from "../scheduler";

const startedAt = Date.now();

export function formatLastRun(run: CommandRunRow | null): string {
  if (!run) return "No command runs yet.";
  return [
    `${run.status.toUpperCase()} ${run.label}`,
    `traceId: ${run.trace_id}`,
    `finished: ${run.finished_at || "-"}`,
    `exit: ${run.exit_code ?? "-"}`,
    "",
    run.output_tail || run.error_message || "(no output)",
  ].join("\n");
}

export function formatLastCommandError(run: CommandRunRow | null): string {
  if (!run) return "No failed command or tool runs yet.";
  return [
    `FAILED ${run.label}`,
    `traceId: ${run.trace_id}`,
    `finished: ${run.finished_at || "-"}`,
    `error: ${run.error_message || "-"}`,
    "",
    run.output_tail || "(no output)",
  ].join("\n");
}

export function formatToolError(tool: TraceEventRow): string {
  return [
    `FAILED TOOL ${tool.event}`,
    `traceId: ${tool.trace_id}`,
    `at: ${tool.created_at}`,
    "",
    JSON.stringify(JSON.parse(tool.payload_json), null, 2),
  ].join("\n");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours) return `${hours}h ${minutes % 60}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function isDebugCommand(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized === "/status" ||
    normalized === "/last" ||
    normalized === "/last-error" ||
    normalized === "/debug" ||
    normalized.startsWith("/debug ") ||
    normalized === "/commands" ||
    normalized === "/schedule" ||
    normalized === "/skills" ||
    normalized === "/help" ||
    normalized === "help"
  );
}

export function handleDebugCommand(text: string, registry: SkillRegistry): string {
  const normalized = text.trim().toLowerCase();
  const catalog = loadCommandCatalog();

  if (normalized === "/help" || normalized === "help") {
    return [
      "My agents",
      "",
      "/status - runtime status",
      "/last - last command result",
      "/last-error - latest failed command",
      "/debug <traceId> - raw trace events",
      "/commands - command aliases grouped by skill",
      "/schedule - configured scheduled checks",
      "/schedule show <name> - schedule details",
      "/schedule history <name> - recent scheduled runs",
      "/schedule run <name> - run one scheduled check now",
      "/schedule enable|disable <name> - change state after confirmation",
      "/schedule interval <name> <minutes> - change interval after confirmation",
      "/skills - scanned skills",
      "",
      "Command aliases:",
      formatCommands(catalog.allow),
    ].join("\n");
  }

  if (normalized === "/commands") {
    return formatCommands(catalog.allow);
  }

  if (normalized === "/schedule") {
    return formatScheduleList(loadScheduledChecks());
  }

  if (normalized === "/skills") {
    const skills = registry.listSkills();
    const errors = registry.listErrors();
    const loaded = skills.length
      ? skills
          .map((skill) => `${skill.slug} - ${skill.name}\n${skill.description}`)
          .join("\n\n")
      : "No skills loaded.";
    if (!errors.length) return loaded;
    return [
      loaded,
      "Registry errors:",
      ...errors.map((error) => `- ${error.slug}: ${error.message}`),
    ].join("\n\n");
  }

  if (normalized === "/status") {
    const currentRun = getJsonState<unknown>("runtime_state", "currentRun");
    const lastScheduledRun = getJsonState<unknown>("runtime_state", "lastScheduledRun");
    return [
      "Status",
      `uptime: ${formatDuration(Date.now() - startedAt)}`,
      `current: ${currentRun ? JSON.stringify(currentRun) : "none"}`,
      `last scheduled: ${lastScheduledRun ? JSON.stringify(lastScheduledRun) : "none"}`,
      `pending confirmations: ${countPendingConfirmations()}`,
      `loaded commands: ${catalog.allow.length}`,
      `loaded skills: ${registry.listSkills().length}`,
      `skill registry errors: ${registry.listErrors().length}`,
      ...registry.listErrors().map((error) => `- ${error.slug}: ${error.message}`),
      `sqlite: ${sqliteFile}`,
    ].join("\n");
  }

  if (normalized === "/last") {
    return formatLastRun(getLastCommandRun());
  }

  if (normalized === "/last-error") {
    const run = getLastFailedCommandRun();
    const tool = getLastFailedToolEvent();
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
    const events = listTraceEvents(traceId, 50).map((row) => ({
      traceId: row.trace_id,
      event: row.event,
      payload: JSON.parse(row.payload_json),
      createdAt: row.created_at,
    }));
    return JSON.stringify(events, null, 2);
  }

  return "Unsupported debug command.";
}

function formatCommands(commands: ReturnType<typeof loadCommandCatalog>["allow"]): string {
  if (!commands.length) return "No commands configured.";
  const grouped = new Map<string, string[]>();
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
