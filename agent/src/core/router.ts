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
import { AiRouter } from "../brain/router";
import {
  deletePendingConfirmation,
  getPendingConfirmation,
  insertChatMessage,
  nowIso,
  upsertPendingConfirmation,
} from "../storage/repositories";
import type { SkillRegistry } from "../skills/registry";
import type { StandardMessage } from "../types/messages";
import { handleDebugCommand, isDebugCommand } from "./debugCommands";
import { presentCommandResult } from "./presenter";

export class Router {
  private readonly hydrator: ContextHydrator;
  private readonly ai = new AiRouter();
  private readonly commandTimeoutMs: number;

  constructor(private readonly registry: SkillRegistry) {
    this.hydrator = new ContextHydrator(registry);
    this.commandTimeoutMs = loadAgentConfig().runtime?.commandTimeoutMs || 10 * 60 * 1000;
  }

  async route(message: StandardMessage): Promise<string> {
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
      reply = await this.routeInner(message);
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

  private async routeInner(message: StandardMessage): Promise<string> {
    const text = message.text.trim();
    const normalized = text.toLowerCase();

    if (isDebugCommand(text)) {
      log.info(
        message.traceId,
        normalized.startsWith("/debug ") ? "debug.trace.requested" : "system.status.requested",
        { command: normalized },
      );
      return handleDebugCommand(text, this.registry);
    }

    const confirmed = await this.consumeConfirmation(message);
    if (confirmed) return confirmed;

    const catalog = loadCommandCatalog();
    const action = catalog.byAlias[normalized];
    if (action) {
      await this.cancelPending(message.chatId);
      return this.prepareOrRun(message, action);
    }

    if (normalized.startsWith("/")) {
      return `Lệnh không tồn tại. Danh sách lệnh hỗ trợ:\n\n${handleDebugCommand("/commands", this.registry)}`;
    }

    const context = this.hydrator.hydrate(message);
    const aiResponse = await this.ai.complete(
      message.traceId,
      this.hydrator.toPromptSections(context),
      message.text,
    );

    if (aiResponse.clarification) return aiResponse.clarification;
    if (aiResponse.commandName) {
      const selected = catalog.allow.find((command) => command.name === aiResponse.commandName);
      if (!selected) return `AI chọn command không nằm trong allowlist: ${aiResponse.commandName}`;
      log.info(message.traceId, "ai.tool.selected", {
        commandName: aiResponse.commandName,
      });
      return this.prepareOrRun(message, selected);
    }

    return aiResponse.text || "Mình chưa hiểu yêu cầu. Gõ /commands để xem lệnh hỗ trợ.";
  }

  private async prepareOrRun(
    message: StandardMessage,
    action: AgentCommand,
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
    const confirmationText = message.text.trim().toLowerCase();
    if (!confirmationText.startsWith("confirm")) return null;
    const match = confirmationText.match(/^confirm\s+(\S+)\s+([a-f0-9]{12})$/);
    if (!match) return "Confirmation cần command name và approval token từ preview.";

    const pending = getPendingConfirmation(message.chatId);
    if (!pending) return "Không có confirmation nào đang chờ.";
    if (pending.expires_at <= nowIso()) {
      deletePendingConfirmation(message.chatId);
      return "Confirmation đã hết hạn. Gửi lại command để tạo confirmation mới.";
    }
    let payload: {
      action: AgentCommand;
      preview: ReturnType<typeof previewCommand>;
      digest: string;
    };
    let recomputedDigest: string;
    try {
      payload = JSON.parse(pending.payload_json) as typeof payload;
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
    if (pending.command_name.toLowerCase() !== match[1] || payload.digest.slice(0, 12) !== match[2]) {
      return `Confirmation không khớp. Dùng đúng command và approval token trong preview.`;
    }

    deletePendingConfirmation(message.chatId);
    return this.run(message, payload.action, true);
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
