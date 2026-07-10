import { loadAgentConfig } from "../config/app";
import {
  loadCommandCatalog,
  commandPreviewDigest,
  evaluateCommandPermission,
  previewCommand,
  runTrackedCommand,
  type AgentCommand,
} from "../commands";
import { ContextHydrator } from "../context/hydrator";
import { log } from "../logging/logger";
import {
  deletePendingConfirmation,
  getScheduledJob,
  getPendingConfirmation,
  insertChatMessage,
  nowIso,
  upsertPendingConfirmation,
} from "../storage/repositories";
import type { SkillRegistry } from "../skills/registry";
import type { StandardMessage } from "../types/messages";
import { AgentToolLoop } from "../tools/loop";
import { handleDebugCommand, isDebugCommand } from "./debugCommands";
import { presentCommandResult } from "./presenter";
import {
  applyScheduleUpdate,
  findScheduledCheck,
  formatScheduleDetails,
  formatScheduleHistory,
  formatScheduledCheckResult,
  formatScheduleList,
  loadScheduledChecks,
  runScheduledCheck,
  scheduleUpdatePreview,
} from "../scheduler";

export class Router {
  private readonly hydrator: ContextHydrator;
  private readonly commandTimeoutMs: number;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly toolLoop = new AgentToolLoop(),
  ) {
    this.hydrator = new ContextHydrator(registry);
    this.commandTimeoutMs = loadAgentConfig().runtime?.commandTimeoutMs || 10 * 60 * 1000;
  }

  async route(message: StandardMessage, onReplyMarkup?: (markup: unknown) => void): Promise<string> {
    log.info(message.traceId, "route.started", {
      provider: message.provider,
      chatId: message.chatId,
    });
    insertChatMessage({
      chatId: message.chatId,
      userId: message.userId,
      role: "user",
      content: message.text,
      traceId: message.traceId,
    });

    let reply: string;
    try {
      reply = await this.routeInner(message, onReplyMarkup);
      insertChatMessage({
        chatId: message.chatId,
        userId: "agent",
        role: "assistant",
        content: reply,
        traceId: message.traceId,
      });
      log.info(message.traceId, "route.completed", {});
      return reply;
    } catch (error) {
      log.error(message.traceId, "route.completed", { error });
      throw error;
    }
  }

  private async routeInner(message: StandardMessage, onReplyMarkup?: (markup: unknown) => void): Promise<string> {
    const text = message.text.trim();
    const normalized = text.toLowerCase();

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
        chatId: message.chatId,
        defaultTimeoutMs: this.commandTimeoutMs,
      });
      return formatScheduledCheckResult(result);
    }

    const scheduleUpdate = this.parseScheduleUpdate(normalized);
    if (scheduleUpdate) {
      const row = getScheduledJob(scheduleUpdate.name);
      if (!row) return `Scheduled check not found: ${scheduleUpdate.name}`;
      const versionedScheduleUpdate = { ...scheduleUpdate, expectedVersion: row.version };
      const { preview, digest } = scheduleUpdatePreview(versionedScheduleUpdate);
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      upsertPendingConfirmation({
        chatId: message.chatId,
        traceId: message.traceId,
        commandName: `schedule.${scheduleUpdate.action}.${scheduleUpdate.name}`,
        payload: { scheduleUpdate: versionedScheduleUpdate, preview, digest },
        expiresAt,
      });

      if (onReplyMarkup) {
        onReplyMarkup({
          inline_keyboard: [
            [
              {
                text: `✅ Xác nhận Update Schedule`,
                callback_data: `confirm schedule.${scheduleUpdate.action}.${scheduleUpdate.name} ${digest.slice(0, 12)}`,
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
        `Approval: ${digest.slice(0, 12)}`,
        `Gõ: confirm schedule.${scheduleUpdate.action}.${scheduleUpdate.name} ${digest.slice(0, 12)}`,
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

    const toolConfirmed = await this.toolLoop.consumeConfirmation(message);
    if (toolConfirmed) return toolConfirmed;
    const confirmed = await this.consumeConfirmation(message);
    if (confirmed) return confirmed;

    const catalog = loadCommandCatalog();
    const action = catalog.byAlias[normalized];
    if (action) {
      await this.cancelPending(message.chatId);
      return this.prepareOrRun(message, action, onReplyMarkup);
    }

    if (normalized.startsWith("/")) {
      return `Lệnh không tồn tại. Danh sách lệnh hỗ trợ:\n\n${handleDebugCommand("/commands", this.registry)}`;
    }

    const context = this.hydrator.hydrate(message);
    return this.toolLoop.run(message, this.hydrator.toPromptSections(context));
  }

  private async prepareOrRun(
    message: StandardMessage,
    action: AgentCommand,
    onReplyMarkup?: (markup: unknown) => void,
  ): Promise<string> {
    const decision = evaluateCommandPermission(action);
    if (decision.outcome === "deny") {
      return `Từ chối [${decision.reasonCode}]: ${decision.reason}`;
    }
    if (decision.outcome === "confirm") {
      const preview = previewCommand(action, this.commandTimeoutMs);
      const digest = commandPreviewDigest(preview);
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      upsertPendingConfirmation({
        chatId: message.chatId,
        traceId: message.traceId,
        commandName: action.name || action.label,
        payload: { action, preview, digest },
        expiresAt,
      });

      if (onReplyMarkup) {
        onReplyMarkup({
          inline_keyboard: [
            [
              {
                text: `✅ Xác nhận: ${action.label}`,
                callback_data: `confirm ${action.name || action.label} ${digest.slice(0, 12)}`,
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
        `Approval: ${digest.slice(0, 12)}`,
        `Gõ: confirm ${action.name || action.label} ${digest.slice(0, 12)}`,
      ].join("\n");
    }

    return this.run(message, action, false);
  }

  private async consumeConfirmation(message: StandardMessage): Promise<string | null> {
    const text = message.text.trim().toLowerCase();

    // Check if it's a confirmation message
    const isShortConfirm = text === "y" || text === "yes" || text === "confirm";
    const matchTokenOnly = text.match(/^confirm\s+([a-f0-9]{12})$/);
    const matchFull = text.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);

    if (!isShortConfirm && !matchTokenOnly && !matchFull) {
      if (text.startsWith("confirm")) {
        return "Confirmation cần command name và approval token từ preview, hoặc chỉ cần gõ 'confirm', 'y', 'yes'.";
      }
      return null;
    }

    const pending = getPendingConfirmation(message.chatId);
    if (!pending) {
      if (text.startsWith("confirm") || text === "y" || text === "yes") {
        return "Không có confirmation nào đang chờ.";
      }
      return null;
    }

    if (pending.expires_at <= nowIso()) {
      deletePendingConfirmation(message.chatId);
      return "Confirmation đã hết hạn. Gửi lại command để tạo confirmation mới.";
    }

    let payload: {
      action: AgentCommand;
      preview: ReturnType<typeof previewCommand>;
      digest: string;
      scheduleUpdate?: ReturnType<Router["parseScheduleUpdate"]>;
    };
    let recomputedDigest: string;
    try {
      payload = JSON.parse(pending.payload_json) as typeof payload;
      if (payload.scheduleUpdate) {
        recomputedDigest = scheduleUpdatePreview(payload.scheduleUpdate).digest;
        if (payload.digest !== recomputedDigest) {
          throw new Error("Pending schedule update digest mismatch.");
        }

        // Match check
        if (matchFull) {
          if (pending.command_name.toLowerCase() !== matchFull[1] || payload.digest.slice(0, 12) !== matchFull[2]) {
            return `Confirmation không khớp. Dùng đúng command và approval token trong preview.`;
          }
        } else if (matchTokenOnly) {
          if (payload.digest.slice(0, 12) !== matchTokenOnly[1]) {
            return `Confirmation token không khớp.`;
          }
        }
        // If isShortConfirm (just "confirm", "y", "yes"), we auto-match without token check.

        deletePendingConfirmation(message.chatId);
        return applyScheduleUpdate(payload.scheduleUpdate);
      }

      if (!payload.action || !payload.preview || typeof payload.digest !== "string") {
        throw new Error("Pending confirmation payload is incomplete.");
      }
      recomputedDigest = commandPreviewDigest(previewCommand(payload.action, this.commandTimeoutMs));
      if (payload.digest !== recomputedDigest || commandPreviewDigest(payload.preview) !== recomputedDigest) {
        throw new Error("Pending confirmation digest mismatch.");
      }
    } catch (error) {
      deletePendingConfirmation(message.chatId);
      log.warn(message.traceId, "confirmation.integrity_failed", {
        commandName: pending.command_name,
        error: error instanceof Error ? error.message : String(error),
      });
      return "Confirmation không còn hợp lệ vì action đã thay đổi. Gửi lại command để tạo preview mới.";
    }

    // Match check for commands
    if (matchFull) {
      if (pending.command_name.toLowerCase() !== matchFull[1] || payload.digest.slice(0, 12) !== matchFull[2]) {
        return `Confirmation không khớp. Dùng đúng command và approval token trong preview.`;
      }
    } else if (matchTokenOnly) {
      if (payload.digest.slice(0, 12) !== matchTokenOnly[1]) {
        return `Confirmation token không khớp.`;
      }
    }

    deletePendingConfirmation(message.chatId);
    return this.run(message, payload.action, true);
  }

  private parseScheduleUpdate(
    normalized: string,
  ): { action: "enable" | "disable" | "interval" | "delivery"; name: string; value?: string | number } | null {
    const parts = normalized.split(/\s+/);
    if (parts[0] !== "/schedule") return null;
    if ((parts[1] === "enable" || parts[1] === "disable") && parts[2]) {
      return { action: parts[1], name: parts[2] };
    }
    if (parts[1] === "interval" && parts[2] && parts[3]) {
      return { action: "interval", name: parts[2], value: Number(parts[3]) };
    }
    if (parts[1] === "delivery" && parts[2] && parts[3]) {
      return { action: "delivery", name: parts[2], value: parts[3] };
    }
    return null;
  }

  private async cancelPending(chatId: string): Promise<void> {
    if (getPendingConfirmation(chatId)) deletePendingConfirmation(chatId);
  }

  private async run(
    message: StandardMessage,
    action: AgentCommand,
    confirmationGranted = false,
  ): Promise<string> {
    const result = await runTrackedCommand({
      traceId: message.traceId,
      chatId: message.chatId,
      action,
      defaultTimeoutMs: this.commandTimeoutMs,
      confirmationGranted,
    });
    const ok = result.exitCode === 0 && !result.signal;
    return presentCommandResult({
      label: action.label,
      traceId: message.traceId,
      ok,
      exit: String(result.exitCode || result.signal || "unknown"),
      output: result.output,
    });
  }
}
