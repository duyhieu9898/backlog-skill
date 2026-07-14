import type { AiToolCall, AiToolDefinition } from "../brain/provider";
import type { ToolResult } from "./contracts";

/**
 * Risk classification declared by a custom tool author at registration time.
 * It is the only policy input for custom tools: routine runs without a prompt,
 * sensitive requires a scoped owner approval, and destructive is always denied.
 */
export type ToolRiskLevel = "routine" | "sensitive" | "destructive";

/**
 * Minimal prepared-call shape returned by a custom tool's prepare handler.
 *
 * Deliberately does not import {@link PreparedToolCall} from executor.ts: the
 * executor imports this module one-way, and structural typing lets the executor
 * pass a full PreparedToolCall back into an execute handler typed on this shape.
 */
export type CustomToolPrepared = {
  call: AiToolCall;
  key: string;
  digest: string;
  preview: string;
};

export type ToolExecuteContext = {
  traceId: string;
  chatId: string;
  confirmationGranted?: boolean;
  signal?: AbortSignal;
};

export type RegisteredTool = {
  definition: AiToolDefinition;
  risk: ToolRiskLevel;
  prepare: (call: AiToolCall) => CustomToolPrepared;
  execute: (prepared: CustomToolPrepared, context: ToolExecuteContext) => Promise<ToolResult> | ToolResult;
};

const BUILTIN_NAMES = new Set(["computer", "browser", "command.run"]);
const BUILTIN_PREFIXES = ["command.", "file.", "web."];

function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.has(name) || BUILTIN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Source-managed registry of custom tools (ADR 0017 P1.1).
 *
 * Tools are registered explicitly via {@link registerTool}; there is no
 * directory scan, dynamic import, or drop-in plugin loading. The registry is
 * empty by default, so when no custom tools are registered the executor and
 * gateway behave exactly as before.
 */
class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): void {
    const name = tool.definition.name;
    if (!name) throw new Error("Custom tool definition must declare a name.");
    if (isBuiltinName(name)) throw new Error(`Custom tool name collides with a built-in tool: ${name}`);
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    this.tools.set(name, tool);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  definitions(): AiToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /** Test-only: clear all registrations for isolation between test files. */
  clear(): void {
    this.tools.clear();
  }
}

export const toolRegistry = new ToolRegistry();

export function registerTool(tool: RegisteredTool): void {
  toolRegistry.register(tool);
}
