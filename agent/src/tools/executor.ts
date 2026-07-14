import crypto from "node:crypto";

import {
  commandPreviewDigest,
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
import { loadAgentConfig } from "../config/app";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { DesktopToolAction, FileToolAction, ToolResult, BrowserToolAction } from "./contracts";
import { browserService } from "../browser/browser-service";
import { BrowserError } from "../browser/errors";
import { validateJsonSchema, type JsonSchema } from "./schema";
import type { BrowserActionPolicyContext } from "../browser/action-policy";
import { refStore } from "../browser/ref-store";

export type PreparedToolCall = {
  call: AiToolCall;
  key: string;
  digest: string;
  preview: string;
  requiresConfirmation: boolean;
  command?: AgentCommand;
  fileAction?: FileToolAction;
  desktopAction?: DesktopToolAction;
  browserAction?: BrowserToolAction;
  actionFingerprint?: string;
  computerInput?: ComputerInput | ComputerLaunch | { action: "screenshot"; displayId?: string };
  webCapture?: { url: string };
  blocked?: ToolResult;
  userIntent?: string;
  approvalGranted?: boolean;
};

const emptyObjectSchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const genericCommandDefinition: AiToolDefinition = {
  name: "command.run",
  description: "Run an arbitrary local command. Prefer executable plus args. shellCommand is available only when a pipeline, redirect, glob, conditional, or multi-step shell script is necessary.",
  inputSchema: {
    type: "object",
    properties: {
      executable: { type: "string", minLength: 1, maxLength: 4096 },
      args: { type: "array", items: { type: "string", maxLength: 16384 }, maxItems: 512 },
      shellCommand: { type: "string", minLength: 1, maxLength: 65536 },
      cwd: { type: "string", minLength: 1, maxLength: 4096 },
      env: { type: "object", properties: {}, additionalProperties: true },
      timeoutMs: { type: "integer", minimum: 1, maximum: 3600000 },
      maxOutputBytes: { type: "integer", minimum: 1024, maximum: 10485760 },
    },
    required: ["cwd"],
    additionalProperties: false,
  },
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

const browserDefinition: AiToolDefinition = {
  name: "browser",
  description: "Interact with the managed Chromium browser. Open URLs, navigate, close tabs, list tabs, focus tabs, and take screenshots.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "start", "stop", "tabs", "open", "focus", "close", "navigate", "snapshot", "act", "screenshot"]
      },
      profile: { type: "string" },
      url: { type: "string" },
      targetId: { type: "string" },
      fullPage: { type: "boolean" },
      ref: { type: "string" },
      request: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["click", "fill", "type", "press", "select", "scroll", "wait"] },
          ref: { type: "string" },
          value: { type: "string" },
          text: { type: "string" },
          key: { type: "string" },
          direction: { type: "string", enum: ["up", "down"] },
          amount: { type: "integer" },
          milliseconds: { type: "integer" },
          snapshotId: { type: "string" }
        },
        required: ["kind"]
      }
    },
    required: ["action"],
    additionalProperties: false
  }
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

export const computerController = new ComputerController();

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

function resizeImage(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    spawnSync("python3", [
      "-c",
      `from PIL import Image; im = Image.open("${filePath}"); im.thumbnail((768, 768)); im.save("${filePath}", "PNG")`
    ]);
  } catch (error) {
    console.error("Failed to resize image:", error);
  }
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
    return [...files, genericCommandDefinition, ...commandDefinitions, computerDefinition, webCaptureDefinition, browserDefinition].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Resolve a trusted shortcut into a command action without deciding policy. */
  prepareCommand(action: AgentCommand, defaultTimeoutMs?: number): PreparedToolCall {
    const preview = previewCommand(action, defaultTimeoutMs);
    return {
      call: { name: `command.${action.name || "run"}`, arguments: (action.invocationInput || {}) as Record<string, unknown> },
      key: action.name || "command.run",
      digest: commandPreviewDigest(preview),
      preview: [
        action.label,
        ...(preview.shellCommand ? [`Shell: ${preview.shellCommand}`] : [`Executable: ${preview.executable}`, `Args: ${JSON.stringify(preview.args)}`]),
        `Cwd: ${preview.cwd}`,
        `Timeout: ${preview.timeoutMs} ms`,
      ].join("\n"),
      requiresConfirmation: false,
      command: action,
    };
  }

  prepare(call: AiToolCall, traceId: string, definitions = this.definitions(), chatId?: string): PreparedToolCall {
    const definition = definitions.find((tool) => tool.name === call.name);
    if (!definition) throw new Error(`Unknown tool: ${call.name}`);
    const errors = validateJsonSchema(definition.inputSchema, call.arguments, "arguments");
    if (errors.length) throw new Error(`Invalid tool arguments for ${call.name}: ${errors.join(" ")}`);

    if (call.name === "command.run") {
      const input = call.arguments as Record<string, unknown>;
      const executable = typeof input.executable === "string" ? input.executable : undefined;
      const shellCommand = typeof input.shellCommand === "string" ? input.shellCommand : undefined;
      if (Boolean(executable) === Boolean(shellCommand)) {
        throw new Error("command.run requires exactly one of executable or shellCommand.");
      }
      const args = input.args === undefined ? [] : input.args;
      if (!Array.isArray(args) || args.some((value) => typeof value !== "string")) throw new Error("command.run args must be an array of strings.");
      const env = input.env;
      if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env as Record<string, unknown>).some((value) => typeof value !== "string"))) {
        throw new Error("command.run env must map variable names to strings.");
      }
      const command: AgentCommand = {
        name: "command.run",
        label: executable ? `Run ${executable}` : "Run shell command",
        cwd: String(input.cwd),
        ...(executable ? { argv: [executable, ...args] as [string, ...string[]] } : { shellCommand }),
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs as number } : {}),
        ...(input.maxOutputBytes ? { maxOutputBytes: input.maxOutputBytes as number } : {}),
        requiresConfirmation: false,
        externalSideEffect: false,
      };
      const preview = previewCommand(command);
      return {
        call,
        key: "command.run",
        digest: commandPreviewDigest(preview),
        requiresConfirmation: false,
        command,
        preview: [
          command.label,
          ...(preview.shellCommand ? [`Shell: ${preview.shellCommand}`] : [`Executable: ${preview.executable}`, `Args: ${JSON.stringify(preview.args)}`]),
          `Cwd: ${preview.cwd}`,
          `Timeout: ${preview.timeoutMs} ms`,
        ].join("\n"),
      };
    }

    if (call.name.startsWith("command.")) {
      const commandName = call.name.slice("command.".length);
      const base = this.catalogLoader().allow.find((command) => command.name === commandName);
      if (!base) throw new Error(`Unknown allowlisted command: ${commandName}`);
      const command = base.inputSchema ? withCommandInput(base, call.arguments) : base;
      const preview = previewCommand(command);
      const commandDigest = commandPreviewDigest(preview);
      const inputPreview = command.invocationInput === undefined
        ? []
        : [`Input: ${truncate(JSON.stringify(command.invocationInput))}`];
      return {
        call,
        key: commandName,
        digest: commandDigest,
        // PermissionPolicy belongs to ToolGateway. The executor only resolves
        // the concrete command and later executes an already-authorized one.
        requiresConfirmation: false,
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
      const actionDigest = digest(input);
      return { call, key: "computer", digest: actionDigest, preview: `computer.${input.action}: ${JSON.stringify(call.arguments)}`, requiresConfirmation: false, computerInput: input, desktopAction };
    }

    if (call.name === "web.capture") {
      const url = publicHttpsUrl(call.arguments.url);
      return { call, key: "web.capture", digest: digest({ url }), preview: `web.capture: ${url}`, requiresConfirmation: false, webCapture: { url } };
    }

    if (call.name === "browser") {
      const args = call.arguments as Record<string, any>;
      const action: BrowserToolAction = {
        kind: `browser.${args.action}`,
        ...args
      } as unknown as BrowserToolAction;
      const browserContext = buildBrowserActionPolicyContext(args, action.kind);
      const actionDigest = digest(action);
      return {
        call,
        key: "browser",
        digest: actionDigest,
        preview: formatBrowserPreview(args, browserContext),
        requiresConfirmation: false,
        browserAction: action,
      };
    }

    const action = fileAction(call);
    const actionDigest = digest(action);
    return {
      call,
      key: call.name,
      digest: actionDigest,
      preview: `${call.name}: ${(call.arguments.path as string) || ""}`,
      requiresConfirmation: false,
      fileAction: action,
    };
  }

  async execute(
    prepared: PreparedToolCall,
    input: { traceId: string; chatId: string; confirmationGranted?: boolean; gatewayAuthorized?: boolean; userIntent?: string; signal?: AbortSignal },
  ): Promise<ToolResult> {
    if (!input.gatewayAuthorized) {
      return {
        ok: false,
        code: "TOOL_GATEWAY_REQUIRED",
        summary: "Tool execution must be authorized by ToolGateway.",
      };
    }
    if (prepared.blocked) return prepared.blocked;
    if (prepared.command) {
      try {
        const result = await runTrackedCommand({
          traceId: input.traceId,
          chatId: input.chatId,
          action: prepared.command,
          confirmationGranted: input.confirmationGranted,
          userIntent: input.userIntent,
          signal: input.signal,
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
      const isInput = prepared.computerInput.action !== "screenshot" && prepared.computerInput.action !== "launch";
      const leaseActive = isInput && computerController.hasLease(input.chatId);
      try {
        if (prepared.computerInput.action === "screenshot") {
          if (!("capture" in adapter) || typeof adapter.capture !== "function") throw new Error("Desktop adapter cannot capture.");
          const captured = adapter.capture(prepared.computerInput.displayId);
          resizeImage(captured.path);
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
          resizeImage(captured.path);
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
          resizeImage(captured.path);
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
      try {
        const child = spawn("google-chrome", [prepared.webCapture.url], { detached: true, stdio: "ignore" });
        child.unref();
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const adapter = getDesktopAdapter();
        if (!("capture" in adapter) || typeof adapter.capture !== "function") {
          throw new Error("Desktop adapter capture is unavailable for interactive mode.");
        }
        const captured = adapter.capture();
        resizeImage(captured.path);
        const artifact = new ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: fs.readFileSync(captured.path) });
        fs.rmSync(captured.path, { force: true });
        return { ok: true, code: "WEB_CAPTURED", summary: `Opened ${prepared.webCapture.url} interactively and captured screen.`, data: { artifactId: artifact.id, url: prepared.webCapture.url } };
      } catch (guiError) {
        const file = path.join(os.tmpdir(), `my-agent-web-${Date.now()}.png`);
        try {
          const result = spawnSync("google-chrome", ["--headless", "--disable-gpu", "--hide-scrollbars", "--window-size=1440,1080", `--screenshot=${file}`, "--virtual-time-budget=3000", prepared.webCapture.url], { encoding: "utf8", timeout: 30_000 });
          if (result.status !== 0 || !fs.existsSync(file)) throw new Error(result.stderr.trim() || "Headless Chrome fallback capture failed.");
          resizeImage(file);
          const artifact = new ArtifactStore().create({ ownerChatId: input.chatId, sourceTraceId: input.traceId, mimeType: "image/png", bytes: fs.readFileSync(file) });
          return { ok: true, code: "WEB_CAPTURED", summary: `Captured ${prepared.webCapture.url} via headless fallback.`, data: { artifactId: artifact.id, url: prepared.webCapture.url } };
        } catch (error) {
          return { ok: false, code: "WEB_CAPTURE_FAILED", summary: `Web capture failed (GUI: ${guiError instanceof Error ? guiError.message : String(guiError)}; Headless: ${error instanceof Error ? error.message : String(error)})` };
        } finally { fs.rmSync(file, { force: true }); }
      }
    }
    if (prepared.browserAction) {
      const action = prepared.browserAction;
      const actionArgs = prepared.call.arguments as Record<string, any>;
      const profile = actionArgs.profile;

      try {
        switch (action.kind) {
          case "browser.status": {
            const res = await browserService.start(profile);
            return { ok: true, code: "BROWSER_STATUS", summary: `Browser profile "${res.profile}" is running.`, data: { browser: { running: true, profile: res.profile } } };
          }
          case "browser.start": {
            const res = await browserService.start(profile);
            return { ok: true, code: "BROWSER_STARTED", summary: `Browser started profile "${res.profile}".`, data: { browser: { running: true, profile: res.profile } } };
          }
          case "browser.stop": {
            await browserService.stop(profile);
            return { ok: true, code: "BROWSER_STOPPED", summary: `Browser stopped profile "${profile || "agent"}".`, data: { browser: { running: false, profile: profile || "agent" } } };
          }
          case "browser.tabs": {
            const tabs = await browserService.listTabs(profile);
            return { ok: true, code: "BROWSER_TABS", summary: `Found ${tabs.length} open tab(s).`, data: { tabs } };
          }
          case "browser.open": {
            const tab = await browserService.open(profile, actionArgs.url);
            return { ok: true, code: "BROWSER_OPENED", summary: `Opened ${actionArgs.url} in ${tab.targetId}.`, data: { target: tab } };
          }
          case "browser.focus": {
            const tab = await browserService.focus(profile, actionArgs.targetId);
            return { ok: true, code: "BROWSER_FOCUSED", summary: `Focused tab ${tab.targetId}.`, data: { target: tab } };
          }
          case "browser.close": {
            await browserService.close(profile, actionArgs.targetId);
            return { ok: true, code: "BROWSER_CLOSED", summary: `Closed tab ${actionArgs.targetId}.` };
          }
          case "browser.navigate": {
            const tab = await browserService.navigate(profile, actionArgs.targetId, actionArgs.url);
            return { ok: true, code: "BROWSER_NAVIGATED", summary: `Navigated tab ${tab.targetId} to ${actionArgs.url}.`, data: { target: tab } };
          }
          case "browser.screenshot": {
            const artifact = await browserService.screenshot(profile, actionArgs.targetId, {
              fullPage: actionArgs.fullPage,
              chatId: input.chatId,
              traceId: input.traceId
            });
            return {
              ok: true,
              code: "BROWSER_SCREENSHOT",
              summary: "Page screenshot captured.",
              data: {
                artifactId: artifact.id,
                artifact: {
                  id: artifact.id,
                  type: "image",
                  mimeType: "image/png",
                  path: artifact.path
                }
              }
            };
          }
          case "browser.snapshot": {
            const snapshot = await browserService.snapshot(profile, actionArgs.targetId);
            return { ok: true, code: "BROWSER_SNAPSHOT", summary: "Accessibility tree snapshot captured.", data: { snapshot } };
          }
          case "browser.act": {
            const tab = await browserService.act(profile, actionArgs.targetId, actionArgs.request);
            let screenshotArtifact;
            try {
              screenshotArtifact = await browserService.screenshot(profile, actionArgs.targetId, {
                chatId: input.chatId,
                traceId: input.traceId
              });
            } catch (err) {
              // Ignore screenshot failure if action succeeded
            }
            return {
              ok: true,
              code: "BROWSER_ACTION_COMPLETED",
              summary: `Action ${actionArgs.request.kind} completed.`,
              data: {
                target: tab,
                artifactId: screenshotArtifact?.id,
                artifact: screenshotArtifact ? {
                  id: screenshotArtifact.id,
                  type: "image",
                  mimeType: "image/png",
                  path: screenshotArtifact.path
                } : undefined
              }
            };
          }
          default:
            return { ok: false, code: "UNKNOWN_BROWSER_ACTION", summary: `Unknown action kind: ${(action as any).kind}` };
        }
      } catch (error) {
        if (error instanceof BrowserError) {
          return {
            ok: false,
            code: error.code,
            summary: error.message,
            data: { retryable: error.retryable }
          };
        }
        return { ok: false, code: "BROWSER_ERROR", summary: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!prepared.fileAction) throw new Error("Prepared tool call has no executable action.");
    return this.files.execute(prepared.fileAction, {
      traceId: input.traceId,
      confirmationGranted: input.confirmationGranted,
    });
  }
}

export function buildBrowserActionPolicyContext(
  args: Record<string, any>,
  actionKind: string
): BrowserActionPolicyContext | undefined {
  if (actionKind !== "browser.act") return undefined;

  const request = args.request;
  if (!request) return undefined;

  const targetId = args.targetId || "";
  const snapshotId = request.snapshotId;
  const ref = request.ref;

  let url = "";
  let element: BrowserActionPolicyContext["element"] = undefined;

  if (snapshotId) {
    const record = refStore.getRecord(snapshotId);
    if (record) {
      url = record.url || "";
      if (ref) {
        const descriptor = record.refs.get(ref);
        if (descriptor) {
          element = {
            ref,
            role: descriptor.role,
            name: descriptor.name,
            text: descriptor.text,
            placeholder: descriptor.placeholder,
            inputType: descriptor.role === "textbox" && descriptor.name?.toLowerCase().includes("password") ? "password" : undefined
          };
        }
      }
    }
  }

  return {
    sessionId: "sess-1",
    runId: "run-1",
    profile: args.profile || "default",
    targetId,
    snapshotId,
    url,
    action: request,
    element,
  };
}

export function formatBrowserPreview(args: Record<string, any>, browserContext?: BrowserActionPolicyContext): string {
  let preview = `browser.${args.action}: ${JSON.stringify(args)}`;
  const sensitive = args.action === "act" && args.request?.kind === "fill" && (
    args.request.inputType === "password"
    || /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(browserContext?.element?.name || "")
    || /\b(password|pass|secret|token|key|card|cvv|pin)\b/i.test(browserContext?.element?.placeholder || "")
  );
  if (sensitive) preview = `browser.${args.action}: ${JSON.stringify({ ...args, request: { ...args.request, value: "[REDACTED]" } })}`;
  return preview;
}
