import { loadAgentConfig } from "../config/app";
import {
  loadCommandCatalog,
  evaluateCommandPermission,
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
        hasRawCommand: Boolean(aiResponse.rawCommand),
      });
      return this.prepareOrRun(message, selected, aiResponse.rawCommand);
    }

    return aiResponse.text || "Mình chưa hiểu yêu cầu. Gõ /commands để xem lệnh hỗ trợ.";
  }

  private async prepareOrRun(
    message: StandardMessage,
    action: AgentCommand,
    rawCommand?: string,
  ): Promise<string> {
    const decision = evaluateCommandPermission(action, rawCommand);
    if (decision.outcome === "deny") {
      return `Từ chối [${decision.reasonCode}]: ${decision.reason}`;
    }
    if (decision.outcome === "confirm") {
      const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      upsertPendingConfirmation({
        chatId: message.chatId,
        traceId: message.traceId,
        commandName: action.name || action.label,
        payload: { action, rawCommand },
        expiresAt,
      });
      return `${action.label} cần xác nhận trước khi chạy.\nGõ: confirm ${action.name || action.label}`;
    }

    return this.run(message, action, rawCommand, false);
  }

  private async consumeConfirmation(message: StandardMessage): Promise<string | null> {
    const match = message.text.trim().toLowerCase().match(/^confirm\s+(.+)$/);
    if (!match) return null;

    const pending = getPendingConfirmation(message.chatId);
    if (!pending) return "Không có confirmation nào đang chờ.";
    if (pending.expires_at <= nowIso()) {
      deletePendingConfirmation(message.chatId);
      return "Confirmation đã hết hạn. Gửi lại command để tạo confirmation mới.";
    }
    if (pending.command_name.toLowerCase() !== match[1]) {
      return `Confirmation không khớp. Command đang chờ: ${pending.command_name}`;
    }

    deletePendingConfirmation(message.chatId);
    const payload = JSON.parse(pending.payload_json) as {
      action: AgentCommand;
      rawCommand?: string;
    };
    return this.run(message, payload.action, payload.rawCommand, true);
  }

  private async cancelPending(chatId: string): Promise<void> {
    if (getPendingConfirmation(chatId)) deletePendingConfirmation(chatId);
  }

  private async run(
    message: StandardMessage,
    action: AgentCommand,
    rawCommand?: string,
    confirmationGranted = false,
  ): Promise<string> {
    const result = await runTrackedCommand({
      traceId: message.traceId,
      chatId: message.chatId,
      action,
      rawCommand,
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
