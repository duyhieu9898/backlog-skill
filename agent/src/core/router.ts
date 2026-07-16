import { loadAgentConfig } from "../config/app";
import {
  loadCommandCatalog,
  commandPreviewDigest,
  previewCommand,
  stopRunningCommand,
  type AgentCommand,
} from "../commands";
import { log } from "../logging/logger";
import {
  getScheduledJob,
  finishRun,
  resetSession,
} from "../storage/repositories";
import type { SkillRegistry } from "../skills/registry";
import type { StandardMessage } from "../types/messages";
import { AgentToolLoop } from "../tools/loop";
import { ApprovalService } from "../security/approvalService";
import { AgentRuntime } from "../runtime/agentRuntime";
import { handleDebugCommand, isDebugCommand } from "./debugCommands";
import { presentCommandResult } from "./presenter";
import {
  applyScheduleUpdate,
  createRuntimeSchedule,
  findScheduledCheck,
  formatScheduleDetails,
  formatScheduleHistory,
  formatScheduledCheckResult,
  formatScheduleList,
  loadScheduledChecks,
  removeRuntimeSchedule,
  runScheduledCheck,
  scheduleUpdatePreview,
} from "../scheduler";

export class Router {
  private readonly commandTimeoutMs: number;
  private readonly chatLocks = new Map<string, Promise<void>>();
  private readonly approvals = new ApprovalService();
  private readonly runtime: AgentRuntime;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly toolLoop = new AgentToolLoop(),
  ) {
    this.runtime = new AgentRuntime(registry, this.toolLoop);
    this.commandTimeoutMs = loadAgentConfig().runtime?.commandTimeoutMs || 10 * 60 * 1000;
  }

  async route(message: StandardMessage, onReplyMarkup?: (markup: unknown) => void, onArtifact?: (artifactId: string) => void): Promise<string> {
    // A stop must not wait behind the command it is meant to interrupt.
    if (message.text.trim().toLowerCase() === "/stop") {
      return this.routeSerialized(message, onReplyMarkup, onArtifact);
    }
    const previous = this.chatLocks.get(message.chatId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.chatLocks.set(message.chatId, current);
    await previous;
    try {
      return await this.routeSerialized(message, onReplyMarkup, onArtifact);
    } finally {
      release();
      if (this.chatLocks.get(message.chatId) === current) this.chatLocks.delete(message.chatId);
    }
  }

  private async routeSerialized(message: StandardMessage, onReplyMarkup?: (markup: unknown) => void, onArtifact?: (artifactId: string) => void): Promise<string> {
    log.info(message.traceId, "route.started", {
      provider: message.provider,
      chatId: message.chatId,
    });
    try {
      const reply = await this.runtime.execute(message, (signal) => this.routeInner(message, onReplyMarkup, onArtifact, signal));
      log.info(message.traceId, "route.completed", {});
      return reply;
    } catch (error) {
      log.error(message.traceId, "route.completed", { error });
      throw error;
    }
  }

  private async routeInner(message: StandardMessage, onReplyMarkup?: (markup: unknown) => void, onArtifact?: (artifactId: string) => void, signal?: AbortSignal): Promise<string> {
    const text = message.text.trim();
    const normalized = text.toLowerCase();

    if (normalized === "/stop") {
      const cancelledRunId = this.runtime.cancelActiveRun(message.chatId);
      const result = stopRunningCommand();
      const runId = result.traceId || cancelledRunId;
      if (runId) {
        log.info(message.traceId, "run.stop.requested", { runningTraceId: result.traceId, runId });
        return `Đã yêu cầu dừng run đang chạy (traceId: ${runId}).`;
      }
      // No active run or command: cancel a run paused waiting for approval so
      // `/stop` is meaningful before the pending approval expires on its own.
      const cancelledPending = this.approvals.cancelPendingForChat(message.chatId, message.userId);
      if (cancelledPending.length > 0) {
        log.info(message.traceId, "run.stop.pending_cancelled", { runIds: cancelledPending });
        return cancelledPending.length === 1
          ? `Đã huỷ run đang chờ xác nhận (traceId: ${cancelledPending[0]}).`
          : `Đã huỷ ${cancelledPending.length} run đang chờ xác nhận.`;
      }
      return "Không có run hoặc lệnh nào đang chạy.";
    }

    if (normalized === "/reset") {
      const newSessionId = resetSession(message.chatId);
      log.info(message.traceId, "chat.history.reset", { chatId: message.chatId, newSessionId });
      return "Đã bắt đầu phiên trò chuyện mới. Lịch sử cũ đã được lưu trữ!";
    }

    if (normalized === "/schedule") {
      return formatScheduleList(loadScheduledChecks());
    }

    if (normalized.startsWith("/schedule show ")) {
      const name = normalized.replace("/schedule show ", "").trim();
      return formatScheduleDetails(name);
    }

    if (normalized.startsWith("/schedule history ")) {
      const name = normalized.replace("/schedule history ", "").trim();
      return formatScheduleHistory(name);
    }

    if (normalized.startsWith("/schedule run ")) {
      const name = normalized.replace("/schedule run ", "").trim();
      const check = findScheduledCheck(name);
      if (!check) return `Scheduled check not found: ${name}`;
      const result = await runScheduledCheck({
        check,
        principalId: message.userId,
        chatId: message.chatId,
        defaultTimeoutMs: this.commandTimeoutMs,
      });
      return formatScheduledCheckResult(result);
    }

    const runtimeSchedule = this.parseRuntimeSchedule(normalized);
    if (runtimeSchedule) {
      try {
        if (runtimeSchedule.action === "add") {
          const check = createRuntimeSchedule({
            name: runtimeSchedule.name,
            command: runtimeSchedule.command,
            cron: runtimeSchedule.cron,
            enabled: true,
          });
          return `Created runtime schedule ${check.name} (${check.cron}) for ${check.command.name}.`;
        }
        if (!removeRuntimeSchedule(runtimeSchedule.name)) {
          return `Runtime schedule not found: ${runtimeSchedule.name}. Config schedules must be removed from config.json.`;
        }
        return `Deleted runtime schedule ${runtimeSchedule.name}.`;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }

    const scheduleUpdate = this.parseScheduleUpdate(normalized);
    if (scheduleUpdate) {
      const row = getScheduledJob(scheduleUpdate.name);
      if (!row) return `Scheduled check not found: ${scheduleUpdate.name}`;
      const versionedScheduleUpdate = { ...scheduleUpdate, expectedVersion: row.version };
      const { preview, digest } = scheduleUpdatePreview(versionedScheduleUpdate);
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      const pending = this.approvals.create({
        runId: message.traceId, principalId: message.userId, chatId: message.chatId,
        description: `Cho phép cập nhật schedule ${scheduleUpdate.name} trong run này.`,
        actionDigest: digest, payload: { scheduleUpdate: versionedScheduleUpdate }, expiresAt,
      });

      if (onReplyMarkup) {
        onReplyMarkup({
          inline_keyboard: [
            [
              {
                text: "✅ Approve", callback_data: `approve ${pending.short_id}`,
              },
              {
                text: "❌ Reject", callback_data: `reject ${pending.short_id}`,
              },
            ],
          ],
        });
      }

      return [
        `Schedule update needs confirmation.`,
        `Action: ${scheduleUpdate.action}`,
        `Name: ${scheduleUpdate.name}`,
        `Version: ${row.version}`,
        scheduleUpdate.value === undefined ? "" : `Value: ${scheduleUpdate.value}`,
        `Approval ID: ${pending.short_id}`,
        `Gõ: approve ${pending.short_id} hoặc reject ${pending.short_id}`,
      ].filter(Boolean).join("\n");
    }

    if (isDebugCommand(text)) {
      log.info(
        message.traceId,
        normalized.startsWith("/debug ") ? "debug.trace.requested" : "system.status.requested",
        { command: normalized },
      );
      return handleDebugCommand(text, this.registry);
    }

    const toolScopedApproval = await this.toolLoop.consumeScopedApproval(message, onArtifact, onReplyMarkup, signal);
    if (toolScopedApproval) return toolScopedApproval;
    const scopedApproval = await this.consumeScopedApproval(message, signal);
    if (scopedApproval) return scopedApproval;

    const catalog = loadCommandCatalog();
    const action = catalog.byAlias[normalized];
    if (action) {
      return this.prepareOrRun(message, action, onReplyMarkup, signal);
    }

    if (normalized.startsWith("/")) {
      return `Lệnh không tồn tại. Danh sách lệnh hỗ trợ:\n\n${handleDebugCommand("/commands", this.registry)}`;
    }

    return this.runtime.runAgent(message, onReplyMarkup, onArtifact, signal);
  }

  private async prepareOrRun(
    message: StandardMessage,
    action: AgentCommand,
    onReplyMarkup?: (markup: unknown) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    const prepared = this.runtime.prepareCommand(action, this.commandTimeoutMs, message.text);
    if (prepared.blocked) {
      return `Từ chối [${prepared.blocked.code}]: ${prepared.blocked.summary}`;
    }
    if (prepared.requiresConfirmation) {
      const preview = previewCommand(action, this.commandTimeoutMs);
      const digest = prepared.digest;
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      const pending = this.approvals.create({
        runId: message.traceId,
        principalId: message.userId,
        chatId: message.chatId,
        description: `Cho phép chạy ${action.label} trong run này.`,
        actionDigest: digest,
        payload: { action, preview },
        expiresAt,
      });

      if (onReplyMarkup) {
        onReplyMarkup({
          inline_keyboard: [
            [
              {
                text: "✅ Approve",
                callback_data: `approve ${pending.short_id}`,
              },
              {
                text: "❌ Reject",
                callback_data: `reject ${pending.short_id}`,
              },
            ],
          ],
        });
      }

      return [
        `${action.label} cần xác nhận trước khi chạy.`,
        `Executable: ${preview.executable}`,
        `Args: ${JSON.stringify(preview.args)}`,
        `Cwd: ${preview.cwd}`,
        `Timeout: ${preview.timeoutMs} ms`,
        `Phạm vi: Cho phép chạy ${action.label} trong run này.`,
        `Approval ID: ${pending.short_id}`,
        `Gõ: approve ${pending.short_id} hoặc reject ${pending.short_id}`,
      ].join("\n");
    }

    return this.run(message, action, false, signal);
  }

  private async consumeScopedApproval(message: StandardMessage, signal?: AbortSignal): Promise<string | null> {
    const match = message.text.trim().toLowerCase().match(/^(approve|reject)\s+([a-f0-9]{8})$/);
    if (!match) return null;
    const candidate = this.approvals.get(match[2], message.userId, message.chatId);
    if (!candidate) return "Approval không tồn tại, đã hết hạn, hoặc không còn hợp lệ.";
    let payload: { action?: AgentCommand; preview?: ReturnType<typeof previewCommand>; scheduleUpdate?: ReturnType<Router["parseScheduleUpdate"]> & { expectedVersion: number } };
    try {
      payload = JSON.parse(candidate.payload_json) as typeof payload;
      if (payload.scheduleUpdate) {
        const digest = scheduleUpdatePreview(payload.scheduleUpdate).digest;
        const pending = this.approvals.resolve({ shortId: match[2], principalId: message.userId, chatId: message.chatId, actionDigest: digest, approve: match[1] === "approve" });
        if (!pending) return "Approval không tồn tại, đã hết hạn, hoặc action đã thay đổi.";
        if (match[1] === "reject") return "Đã từ chối action đang chờ.";
        const result = applyScheduleUpdate(payload.scheduleUpdate);
        finishRun(pending.run_id, "completed");
        return result;
      }
      if (!payload.action) return null;
    } catch {
      return "Approval không còn hợp lệ.";
    }
    const digest = commandPreviewDigest(previewCommand(payload.action, this.commandTimeoutMs));
    const pending = this.approvals.resolve({
      shortId: match[2], principalId: message.userId, chatId: message.chatId,
      actionDigest: digest, approve: match[1] === "approve",
    });
    if (!pending) return "Approval không tồn tại, đã hết hạn, hoặc không còn hợp lệ.";
    if (match[1] === "reject") return "Đã từ chối action đang chờ.";
    try {
      const result = await this.run(message, payload.action, true, signal);
      finishRun(pending.run_id, "completed");
      return result;
    } catch (error) {
      finishRun(pending.run_id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private parseScheduleUpdate(
    normalized: string,
  ): { action: "enable" | "disable" | "cron" | "delivery"; name: string; value?: string } | null {
    const parts = normalized.split(/\s+/);
    if (parts[0] !== "/schedule") return null;
    if ((parts[1] === "enable" || parts[1] === "disable") && parts[2]) {
      return { action: parts[1], name: parts[2] };
    }
    // /schedule cron <name> <5-field cron expr>
    if (parts[1] === "cron" && parts[2] && parts.length >= 8) {
      return { action: "cron", name: parts[2], value: parts.slice(3).join(" ") };
    }
    if (parts[1] === "delivery" && parts[2] && parts[3]) {
      return { action: "delivery", name: parts[2], value: parts[3] };
    }
    return null;
  }

  private parseRuntimeSchedule(
    normalized: string,
  ): { action: "add"; name: string; cron: string; command: string } | { action: "delete"; name: string } | null {
    const parts = normalized.split(/\s+/);
    if (parts[0] !== "/schedule") return null;
    if (parts[1] === "delete" && parts[2] && parts.length === 3) {
      return { action: "delete", name: parts[2] };
    }
    // /schedule add <name> <minute> <hour> <day-of-month> <month> <day-of-week> <command>
    if (parts[1] === "add" && parts.length === 9) {
      return { action: "add", name: parts[2], cron: parts.slice(3, 8).join(" "), command: parts[8] };
    }
    return null;
  }

  private async run(
    message: StandardMessage,
    action: AgentCommand,
    confirmationGranted = false,
    signal?: AbortSignal,
  ): Promise<string> {
    const prepared = this.runtime.prepareCommand(action, this.commandTimeoutMs, message.text);
    if (prepared.blocked) throw new Error(`Permission deny: ${prepared.blocked.summary}`);
    const result = await this.runtime.runCommand(action, {
      runId: message.traceId,
      traceId: message.traceId,
      chatId: message.chatId,
      defaultTimeoutMs: this.commandTimeoutMs,
      confirmationGranted,
      userIntent: message.text,
      signal,
    });
    const data = result.data as { exitCode?: number; signal?: string; output?: string } | undefined;
    return presentCommandResult({
      label: action.label,
      traceId: message.traceId,
      ok: result.ok,
      exit: String(data?.exitCode ?? data?.signal ?? "unknown"),
      output: data?.output || result.summary,
    });
  }
}
