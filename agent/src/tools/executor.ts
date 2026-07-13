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
import { getDesktopAdapter } from "./computer/linux-x11";
import type { DesktopActionAdapter } from "./computer/contracts";
import { DesktopRegistry } from "./computer/apps";
import { ComputerController, type ComputerInput, type ComputerLaunch, xdotoolArgs } from "./computer/computer-tool";
import { ArtifactStore } from "../artifacts/store";
import { logDesktopEvent } from "./computer/events";
import { PermissionPolicy } from "../security/permissionPolicy";
import { loadAgentConfig } from "../config/app";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { DesktopToolAction, FileToolAction, ToolResult } from "./contracts";
import { validateJsonSchema, type JsonSchema } from "./schema";

export type PreparedToolCall = {
  call: AiToolCall;
  key: string;
  digest: string;
  preview: string;
  requiresConfirmation: boolean;
  command?: AgentCommand;
  fileAction?: FileToolAction;
  desktopAction?: DesktopToolAction;
  computerInput?: ComputerInput | ComputerLaunch | { action: "screenshot"; displayId?: string };
  webCapture?: { url: string };
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

const computerDefinition: AiToolDefinition = {
  name: "computer",
  description: "Capture the screen without confirmation. To control an app, first use launch with its configured human name (for example Visual Studio Code); launch verifies and focuses its window, then returns a fresh screenshot. Every left_click, type, or key requires that successful launch; left_click additionally requires the exact latest frameId. Never use screenshots or coordinates to try to open an app.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["screenshot", "launch", "left_click", "type", "key"] },
      app: { type: "string", minLength: 1, maxLength: 256 },
      frameId: { type: "string", minLength: 1, maxLength: 128 },
      x: { type: "integer", minimum: 0 },
      y: { type: "integer", minimum: 0 },
      text: { type: "string", minLength: 1, maxLength: 10000 },
      key: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const webCaptureDefinition: AiToolDefinition = {
  name: "web.capture",
  description: "Open one public HTTPS URL in local headless Chrome, wait briefly for rendering, and return a PNG screenshot artifact. Use this for a user-supplied website screenshot.",
  inputSchema: { type: "object", properties: { url: { type: "string", minLength: 12, maxLength: 2048 } }, required: ["url"], additionalProperties: false },
};

function publicHttpsUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("web.capture requires arguments.url.");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("web.capture requires a valid URL."); }
  if (url.protocol !== "https:" || !url.hostname || /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) {
    throw new Error("web.capture accepts only public HTTPS URLs.");
  }
  return url.toString();
}

const computerController = new ComputerController();

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function truncate(value: string, max = 4000): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n[truncated]`;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForFocusedWindow(
  adapter: DesktopActionAdapter,
  title: string,
): Promise<{ windowId: string; title: string }> {
  const deadline = Date.now() + 5_000;
  do {
    const focused = adapter.focusWindow(title);
    if (focused) return focused;
    await pause(200);
  } while (Date.now() < deadline);
  throw new Error(`Launched app did not expose a focusable window: ${title}`);
}

function fileAction(call: AiToolCall): FileToolAction {
  return { kind: call.name, ...call.arguments } as FileToolAction;
}

function computerInput(call: AiToolCall): ComputerInput | ComputerLaunch | { action: "screenshot"; displayId?: string } {
  const input = call.arguments as Record<string, unknown>;
  if (input.action === "screenshot") return { action: "screenshot", displayId: input.displayId as string | undefined };
  if (input.action === "launch") {
    if (typeof input.app !== "string" || !input.app.trim()) throw new Error("computer.launch requires arguments.app.");
    return { action: "launch", app: input.app, displayId: input.displayId as string | undefined };
  }
  if (input.action === "left_click") {
    if (typeof input.frameId !== "string" || !input.frameId || !Number.isInteger(input.x) || !Number.isInteger(input.y)) throw new Error("computer.left_click requires frameId and integer x/y.");
    return { action: "left_click", frameId: input.frameId, x: input.x as number, y: input.y as number };
  }
  if (input.action === "type") {
    if (typeof input.text !== "string" || !input.text) throw new Error("computer.type requires arguments.text.");
    return { action: "type", text: input.text };
  }
  if (input.action === "key") {
    if (typeof input.key !== "string" || !input.key) throw new Error("computer.key requires arguments.key.");
    return { action: "key", key: input.key };
  }
  throw new Error(`Unsupported computer action: ${String(input.action)}`);
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
    if (scope?.desktopOnly) return [computerDefinition];
    if (scope?.webOnly) return [webCaptureDefinition];
    const files = scope && !scope.includeFileTools ? [] : fileDefinitions;
    return [...files, ...commandDefinitions, computerDefinition, webCaptureDefinition].sort((a, b) => a.name.localeCompare(b.name));
  }

  prepare(call: AiToolCall, traceId: string, definitions = this.definitions(), chatId?: string): PreparedToolCall {
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

    if (call.name === "computer") {
      const input = computerInput(call);
      const resolvedApp = input.action === "launch"
        ? new DesktopRegistry(loadAgentConfig().desktop?.apps || []).resolve(input.app)
        : undefined;
      if (input.action === "launch" && !resolvedApp) {
        const actionDigest = digest(input);
        return {
          call, key: "computer", digest: actionDigest,
          preview: `Configured desktop app not found: ${input.app}`,
          requiresConfirmation: false, computerInput: input,
          blocked: { ok: false, code: "UNKNOWN_DESKTOP_APP", summary: `No unique configured desktop app matches: ${input.app}` },
        };
      }
      const desktopAction: DesktopToolAction = input.action === "screenshot"
        ? { kind: "desktop.capture", displayId: input.displayId }
        : input.action === "launch"
          ? { kind: "desktop.launch", appId: resolvedApp!.id }
        : { kind: "desktop.act", targetId: input.action === "left_click" ? input.frameId : "focused-target", operation: input.action === "left_click" ? "click" : input.action };
      const adapter = getDesktopAdapter();
      const config = loadAgentConfig();
      const decision = new PermissionPolicy(config.permissions).evaluate(desktopAction, { desktopStatus: adapter.getStatus() });
      const actionDigest = digest(input);
      const leaseActive = input.action !== "screenshot" && input.action !== "launch" && Boolean(chatId && computerController.hasLease(chatId));
      if (decision.outcome === "deny") return { call, key: "computer", digest: actionDigest, preview: decision.reason, requiresConfirmation: false, computerInput: input, desktopAction, blocked: { ok: false, code: decision.reasonCode, summary: decision.reason } };
      return { call, key: "computer", digest: actionDigest, preview: `computer.${input.action}: ${JSON.stringify(call.arguments)}`, requiresConfirmation: decision.outcome === "confirm" && !leaseActive, computerInput: input, desktopAction };
    }

    if (call.name === "web.capture") {
      const url = publicHttpsUrl(call.arguments.url);
      return { call, key: "web.capture", digest: digest({ url }), preview: `web.capture: ${url}`, requiresConfirmation: false, webCapture: { url } };
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
    if (prepared.computerInput && prepared.desktopAction) {
      const adapter = getDesktopAdapter();
      const config = loadAgentConfig();
      const isInput = prepared.computerInput.action !== "screenshot" && prepared.computerInput.action !== "launch";
      const leaseActive = isInput && computerController.hasLease(input.chatId);
      const decision = new PermissionPolicy(config.permissions).evaluate(prepared.desktopAction, { desktopStatus: adapter.getStatus(), confirmationGranted: input.confirmationGranted || leaseActive });
      if (decision.outcome !== "allow") return { ok: false, code: decision.reasonCode, summary: decision.reason };
      try {
        if (prepared.computerInput.action === "screenshot") {
          if (!("capture" in adapter) || typeof adapter.capture !== "function") throw new Error("Desktop adapter cannot capture.");
          const captured = adapter.capture(prepared.computerInput.displayId);
          const artifact = new ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: fs.readFileSync(captured.path) });
          fs.rmSync(captured.path, { force: true });
          const frame = computerController.observe(input.chatId, captured.displayId);
          logDesktopEvent(input.traceId, { component: "desktop", action: "computer.screenshot", outcome: "completed", artifactId: artifact.id });
          return { ok: true, code: "COMPUTER_SCREENSHOT", summary: "Screen captured.", data: { artifactId: artifact.id, frameId: frame.frameId, displayId: captured.displayId, expiresAt: frame.expiresAt } };
        }
        if (prepared.computerInput.action === "launch") {
          if (!("launch" in adapter) || typeof adapter.launch !== "function" || !("focusWindow" in adapter) || typeof adapter.focusWindow !== "function") throw new Error("Desktop adapter cannot launch and verify apps.");
          if (prepared.desktopAction.kind !== "desktop.launch") throw new Error("Computer launch was not prepared as a desktop launch.");
          const actionAdapter = adapter as DesktopActionAdapter;
          const launched = actionAdapter.launch(prepared.desktopAction.appId);
          const app = new DesktopRegistry(loadAgentConfig().desktop?.apps || []).get(launched.appId);
          if (!app) throw new Error(`Launched app is no longer configured: ${launched.appId}`);
          const focused = await waitForFocusedWindow(actionAdapter, app.label);
          const captured = actionAdapter.capture(prepared.computerInput.displayId);
          const artifact = new ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: fs.readFileSync(captured.path) });
          fs.rmSync(captured.path, { force: true });
          const frame = computerController.observe(input.chatId, captured.displayId);
          computerController.bindTarget(input.chatId, captured.displayId);
          logDesktopEvent(input.traceId, { component: "desktop", action: "computer.launch", outcome: "completed", artifactId: artifact.id });
          return { ok: true, code: "COMPUTER_LAUNCHED", summary: `Launched and focused ${launched.appId}, then captured the screen.`, data: { appId: launched.appId, windowId: focused.windowId, windowTitle: focused.title, artifactId: artifact.id, frameId: frame.frameId, displayId: captured.displayId, expiresAt: frame.expiresAt } };
        }
        const actionInput = prepared.computerInput as ComputerInput;
        await computerController.runInput(actionInput, input.chatId, async () => {
          const result = spawnSync("xdotool", xdotoolArgs(actionInput), { encoding: "utf8" });
          if (result.status !== 0) throw new Error(result.stderr.trim() || "X11 input failed.");
        });
        const lease = input.confirmationGranted ? computerController.grantLease(input.chatId) : undefined;
        if (!input.confirmationGranted && leaseActive) computerController.consumeLease(input.chatId);
        try {
          if (!("capture" in adapter) || typeof adapter.capture !== "function") throw new Error("Desktop adapter cannot capture.");
          const captured = adapter.capture(computerController.currentDisplay(input.chatId));
          const artifact = new ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: fs.readFileSync(captured.path) });
          fs.rmSync(captured.path, { force: true });
          const frame = computerController.observe(input.chatId, captured.displayId);
          logDesktopEvent(input.traceId, { component: "desktop", action: `computer.${actionInput.action}`, outcome: "completed", artifactId: artifact.id });
          return { ok: true, code: "COMPUTER_ACTION_COMPLETED", summary: `Computer ${actionInput.action} completed.`, data: { artifactId: artifact.id, frameId: frame.frameId, displayId: captured.displayId, expiresAt: frame.expiresAt, ...(lease ? { controlLease: lease } : {}) } };
        } catch (followUpError) {
          logDesktopEvent(input.traceId, { component: "desktop", action: `computer.${actionInput.action}`, outcome: "completed" });
          return { ok: true, code: "COMPUTER_ACTION_COMPLETED", summary: `Computer ${actionInput.action} completed; follow-up screenshot failed: ${followUpError instanceof Error ? followUpError.message : String(followUpError)}` };
        }
      } catch (error) {
        logDesktopEvent(input.traceId, { component: "desktop", action: `computer.${prepared.computerInput.action}`, outcome: "failed", reasonCode: "DESKTOP_ACTION_FAILED" });
        return { ok: false, code: "DESKTOP_ACTION_FAILED", summary: error instanceof Error ? error.message : String(error) };
      }
    }
    if (prepared.webCapture) {
      const file = path.join(os.tmpdir(), `my-agent-web-${Date.now()}.png`);
      try {
        const result = spawnSync("google-chrome", ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1080", `--screenshot=${file}`, "--virtual-time-budget=3000", prepared.webCapture.url], { encoding: "utf8", timeout: 30_000 });
        if (result.status !== 0 || !fs.existsSync(file)) throw new Error(result.stderr.trim() || "Chrome capture failed.");
        const artifact = new ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: fs.readFileSync(file) });
        return { ok: true, code: "WEB_CAPTURED", summary: `Captured ${prepared.webCapture.url}.`, data: { artifactId: artifact.id, url: prepared.webCapture.url } };
      } catch (error) {
        return { ok: false, code: "WEB_CAPTURE_FAILED", summary: error instanceof Error ? error.message : String(error) };
      } finally { fs.rmSync(file, { force: true }); }
    }
    if (!prepared.fileAction) throw new Error("Prepared tool call has no executable action.");
    return this.files.execute(prepared.fileAction, {
      traceId: input.traceId,
      confirmationGranted: input.confirmationGranted,
    });
  }
}
