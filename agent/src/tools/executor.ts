import crypto from "node:crypto";

import {
  commandPreviewDigest,
  evaluateCommandPermission,
  loadCommandCatalog,
  previewCommand,
  runTrackedCommand,
  withCommandInput,
  type AgentCommand,
} from "../commands";
import type { AiToolCall, AiToolDefinition, AiToolScope } from "../brain/provider";
import { FileTools } from "./files";
import type { FileToolAction, ToolResult } from "./contracts";
import { validateJsonSchema, type JsonSchema } from "./schema";

export type PreparedToolCall = {
  call: AiToolCall;
  key: string;
  digest: string;
  preview: string;
  requiresConfirmation: boolean;
  command?: AgentCommand;
  fileAction?: FileToolAction;
  blocked?: ToolResult;
};

const emptyObjectSchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const fileDefinitions: AiToolDefinition[] = [
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

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function truncate(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function fileAction(call: AiToolCall): FileToolAction {
  return { kind: call.name, ...call.arguments } as FileToolAction;
}

export class ToolExecutor {
  constructor(
    private readonly files = new FileTools(),
    private readonly catalogLoader = loadCommandCatalog,
  ) {}

  definitions(scope?: AiToolScope): AiToolDefinition[] {
    const commands = scope?.skillSlug
      ? this.catalogLoader().allow.filter((command) => command.skillSlug === scope.skillSlug)
      : scope
        ? []
        : this.catalogLoader().allow;
    const commandDefinitions = commands.map<AiToolDefinition>((command) => ({
      name: `command.${command.name}`,
      description: `${command.label}. Fixed argv; ${
        command.requiresConfirmation || command.externalSideEffect
          ? "requires explicit confirmation"
          : "may run without confirmation"
      }.`,
      inputSchema: command.inputSchema || emptyObjectSchema,
    }));
    const files = scope && !scope.includeFileTools ? [] : fileDefinitions;
    return [...files, ...commandDefinitions].sort((a, b) => a.name.localeCompare(b.name));
  }

  prepare(call: AiToolCall, traceId: string, definitions = this.definitions()): PreparedToolCall {
    const definition = definitions.find((tool) => tool.name === call.name);
    if (!definition) throw new Error(`Unknown tool: ${call.name}`);
    const errors = validateJsonSchema(definition.inputSchema, call.arguments, "arguments");
    if (errors.length) throw new Error(`Invalid tool arguments for ${call.name}: ${errors.join(" ")}`);

    if (call.name.startsWith("command.")) {
      const commandName = call.name.slice("command.".length);
      const base = this.catalogLoader().allow.find((command) => command.name === commandName);
      if (!base) throw new Error(`Unknown allowlisted command: ${commandName}`);
      const command = base.inputSchema ? withCommandInput(base, call.arguments) : base;
      const decision = evaluateCommandPermission(command);
      const preview = previewCommand(command);
      const commandDigest = commandPreviewDigest(preview);
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

    const action = fileAction(call);
    const actionDigest = digest(action);
    const requiresConfirmation = ["file.mkdir", "file.write", "file.patch"].includes(call.name);
    let preview = `${call.name}: ${(call.arguments.path as string) || ""}`;
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

  async execute(
    prepared: PreparedToolCall,
    input: { traceId: string; chatId: string; confirmationGranted?: boolean },
  ): Promise<ToolResult> {
    if (prepared.blocked) return prepared.blocked;
    if (prepared.command) {
      try {
        const result = await runTrackedCommand({
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
      } catch (error) {
        return { ok: false, code: "COMMAND_ERROR", summary: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!prepared.fileAction) throw new Error("Prepared tool call has no executable action.");
    return this.files.execute(prepared.fileAction, {
      traceId: input.traceId,
      confirmationGranted: input.confirmationGranted,
    });
  }
}
