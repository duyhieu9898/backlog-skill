import fs from "node:fs";
import path from "node:path";

import { loadAgentConfig } from "../config/app";
import { log } from "../logging/logger";
import { PermissionPolicy } from "../security/permissionPolicy";
import { isDesktopToolAction, isBrowserToolAction } from "./contracts";
import type {
  FileMutationAction,
  FilePatchAction,
  FileToolAction,
  FileWriteAction,
  PolicyDecision,
  ToolResult,
} from "./contracts";

const DEFAULT_MAX_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_LIST_ENTRIES = 500;
const MAX_LIST_ENTRIES = 2000;
const MAX_WRITE_BYTES = 1024 * 1024;
const PREVIEW_BYTES = 4096;

export type FileEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
};

export type FilePreview = {
  kind: FileMutationAction["kind"];
  path: string;
  summary: string;
  before?: string | null;
  after?: string;
  truncated?: boolean;
};

export type FileToolContext = {
  traceId: string;
  confirmationGranted?: boolean;
};

function containsNul(content: Buffer | string): boolean {
  return typeof content === "string" ? content.includes("\0") : content.includes(0);
}

function byteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function truncatePreview(content: string): { content: string; truncated: boolean } {
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length <= PREVIEW_BYTES) return { content, truncated: false };
  return {
    content: `${buffer.subarray(0, PREVIEW_BYTES).toString("utf8")}\n[truncated preview]`,
    truncated: true,
  };
}

function failure<T = never>(code: string, summary: string): ToolResult<T> {
  return { ok: false, code, summary };
}

function actionPath(decision: PolicyDecision): string {
  if (decision.action.kind === "command.run" || isDesktopToolAction(decision.action) || isBrowserToolAction(decision.action)) {
    throw new Error("File policy returned a non-file action.");
  }
  return decision.action.path;
}

function entryType(entry: fs.Dirent): FileEntry["type"] {
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function buildPatchedContent(action: FilePatchAction, current: string): ToolResult<string> {
  if (!action.search) return failure("PATCH_EMPTY_SEARCH", "Patch search text cannot be empty.");
  const first = current.indexOf(action.search);
  if (first < 0) return failure("PATCH_TARGET_NOT_FOUND", "Patch search text was not found.");
  if (current.indexOf(action.search, first + action.search.length) >= 0) {
    return failure("PATCH_TARGET_AMBIGUOUS", "Patch search text must match exactly once.");
  }
  return {
    ok: true,
    code: "PATCH_READY",
    summary: "Patch target matched exactly once.",
    data: `${current.slice(0, first)}${action.replacement}${current.slice(first + action.search.length)}`,
  };
}

export class FileTools {
  constructor(
    private readonly policy = new PermissionPolicy(loadAgentConfig().permissions),
  ) {}

  execute(action: FileToolAction, context: FileToolContext): ToolResult {
    const decision = this.policy.evaluate(action, {
      confirmationGranted: context.confirmationGranted,
    });
    if (decision.outcome === "deny") {
      log.warn(context.traceId, "file.denied", {
        kind: action.kind,
        path: action.path,
        reasonCode: decision.reasonCode,
      });
      return failure(decision.reasonCode, decision.reason);
    }

    if (decision.outcome === "confirm") {
      if (action.kind === "file.read" || action.kind === "file.list" || action.kind === "file.exists") {
        return { ok: false, code: decision.reasonCode, summary: decision.reason };
      }
      const preview = this.previewNormalized(decision.action as FileMutationAction);
      log.info(context.traceId, "file.confirmation_required", {
        kind: action.kind,
        path: actionPath(decision),
        previewCode: preview.code,
      });
      if (!preview.ok) return preview;
      return {
        ok: false,
        code: decision.reasonCode,
        summary: decision.reason,
        data: preview.data,
      };
    }

    try {
      const normalized = decision.action;
      if (normalized.kind === "command.run" || isDesktopToolAction(normalized)) {
        return failure("INVALID_ACTION", "File tool received a non-file action.");
      }
      let result: ToolResult;
      switch (normalized.kind) {
        case "file.read":
          result = this.read(normalized.path, normalized.maxBytes, context.traceId);
          break;
        case "file.list":
          result = this.list(normalized.path, normalized.maxEntries, context.traceId);
          break;
        case "file.exists":
          result = this.exists(normalized.path, context.traceId);
          break;
        case "file.mkdir":
          result = this.mkdir(normalized.path, context.traceId);
          break;
        case "file.write":
          result = this.write(normalized, context.traceId);
          break;
        case "file.patch":
          result = this.patch(normalized, context.traceId);
          break;
        default:
          return failure("INVALID_ACTION", "Unsupported file action.");
      }
      log.info(context.traceId, "file.result", {
        kind: normalized.kind,
        path: normalized.path,
        ok: result.ok,
        code: result.code,
      });
      return result;
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      log.error(context.traceId, "file.failed", { kind: action.kind, path: action.path, error });
      return failure("IO_ERROR", summary);
    }
  }

  private previewNormalized(action: FileMutationAction): ToolResult<FilePreview> {
    try {
      if (action.kind === "file.mkdir") {
        return {
          ok: true,
          code: "PREVIEW_READY",
          summary: "Directory creation preview generated.",
          data: {
            kind: action.kind,
            path: action.path,
            summary: fs.existsSync(action.path) ? "Directory already exists." : "Create directory.",
          },
        };
      }

      if (action.kind === "file.write") {
        const validation = this.validateTextWrite(action.content);
        if (validation) return validation;
        const before = fs.existsSync(action.path) ? this.readTextForMutation(action.path) : null;
        const beforePreview = before === null ? null : truncatePreview(before);
        const afterPreview = truncatePreview(action.content);
        return {
          ok: true,
          code: "PREVIEW_READY",
          summary: "File write preview generated.",
          data: {
            kind: action.kind,
            path: action.path,
            summary: before === null ? "Create text file." : "Replace text file.",
            before: beforePreview?.content ?? null,
            after: afterPreview.content,
            truncated: Boolean(beforePreview?.truncated || afterPreview.truncated),
          },
        };
      }

      if (containsNul(action.search) || containsNul(action.replacement)) {
        return failure("BINARY_CONTENT_REFUSED", "Patch text cannot contain NUL bytes.");
      }
      const current = this.readTextForMutation(action.path);
      const patched = buildPatchedContent(action, current);
      if (!patched.ok || typeof patched.data !== "string") {
        return failure(patched.code, patched.summary);
      }
      const beforePreview = truncatePreview(current);
      const afterPreview = truncatePreview(patched.data);
      return {
        ok: true,
        code: "PREVIEW_READY",
        summary: "File patch preview generated.",
        data: {
          kind: action.kind,
          path: action.path,
          summary: "Replace one exact text match.",
          before: beforePreview.content,
          after: afterPreview.content,
          truncated: beforePreview.truncated || afterPreview.truncated,
        },
      };
    } catch (error) {
      return failure("PREVIEW_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  private read(target: string, requestedMax: number | undefined, traceId: string): ToolResult {
    if (!fs.existsSync(target)) return failure("NOT_FOUND", `File does not exist: ${target}`);
    if (!fs.statSync(target).isFile()) return failure("NOT_FILE", `Path is not a file: ${target}`);
    const maxBytes = Math.max(1, Math.min(requestedMax || DEFAULT_MAX_READ_BYTES, MAX_READ_BYTES));
    const descriptor = fs.openSync(target, "r");
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const sample = buffer.subarray(0, bytesRead);
      if (containsNul(sample)) return failure("BINARY_FILE_REFUSED", `Binary file read refused: ${target}`);
      const truncated = bytesRead > maxBytes;
      const content = sample.subarray(0, maxBytes).toString("utf8");
      const marker = truncated ? `\n[truncated: file exceeds ${maxBytes} bytes]` : "";
      log.info(traceId, "file.read.completed", { path: target, bytesRead, truncated });
      return {
        ok: true,
        code: "FILE_READ",
        summary: truncated ? "Text file read with truncation." : "Text file read.",
        data: { path: target, content: `${content}${marker}`, bytesRead, truncated },
      };
    } finally {
      fs.closeSync(descriptor);
    }
  }

  private list(target: string, requestedMax: number | undefined, traceId: string): ToolResult {
    if (!fs.existsSync(target)) return failure("NOT_FOUND", `Directory does not exist: ${target}`);
    if (!fs.statSync(target).isDirectory()) return failure("NOT_DIRECTORY", `Path is not a directory: ${target}`);
    const maxEntries = Math.max(1, Math.min(requestedMax || DEFAULT_MAX_LIST_ENTRIES, MAX_LIST_ENTRIES));
    const allEntries = fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    const visible = allEntries.filter((entry) => {
      const child = this.policy.evaluate({ kind: "file.exists", path: path.join(target, entry.name) });
      return child.outcome === "allow";
    });
    const truncated = visible.length > maxEntries;
    const entries = visible.slice(0, maxEntries).map<FileEntry>((entry) => ({
      name: entry.name,
      type: entryType(entry),
    }));
    log.info(traceId, "file.list.completed", {
      path: target,
      returned: entries.length,
      denied: allEntries.length - visible.length,
      truncated,
    });
    return {
      ok: true,
      code: "DIRECTORY_LISTED",
      summary: truncated ? "Directory listed with truncation." : "Directory listed.",
      data: { path: target, entries, truncated, deniedEntries: allEntries.length - visible.length },
    };
  }

  private exists(target: string, traceId: string): ToolResult {
    const exists = fs.existsSync(target);
    log.info(traceId, "file.exists.completed", { path: target, exists });
    return { ok: true, code: "EXISTS_CHECKED", summary: "Path existence checked.", data: { path: target, exists } };
  }

  private mkdir(target: string, traceId: string): ToolResult {
    if (fs.existsSync(target)) {
      if (!fs.statSync(target).isDirectory()) return failure("PATH_CONFLICT", `Path exists and is not a directory: ${target}`);
      return { ok: true, code: "DIRECTORY_EXISTS", summary: "Directory already exists.", data: { path: target, created: false } };
    }
    fs.mkdirSync(target, { recursive: true });
    log.info(traceId, "file.mkdir.completed", { path: target });
    return { ok: true, code: "DIRECTORY_CREATED", summary: "Directory created.", data: { path: target, created: true } };
  }

  private write(action: FileWriteAction, traceId: string): ToolResult {
    const validation = this.validateTextWrite(action.content);
    if (validation) return validation;
    const parent = path.dirname(action.path);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      return failure("PARENT_NOT_FOUND", `Parent directory does not exist: ${parent}`);
    }
    this.atomicWrite(action.path, action.content);
    log.info(traceId, "file.write.completed", { path: action.path, bytesWritten: byteLength(action.content) });
    return {
      ok: true,
      code: "FILE_WRITTEN",
      summary: "Text file written.",
      data: { path: action.path, bytesWritten: byteLength(action.content) },
    };
  }

  private patch(action: FilePatchAction, traceId: string): ToolResult {
    if (containsNul(action.search) || containsNul(action.replacement)) {
      return failure("BINARY_CONTENT_REFUSED", "Patch text cannot contain NUL bytes.");
    }
    const current = this.readTextForMutation(action.path);
    const patched = buildPatchedContent(action, current);
    if (!patched.ok || typeof patched.data !== "string") return patched;
    const validation = this.validateTextWrite(patched.data);
    if (validation) return validation;
    this.atomicWrite(action.path, patched.data);
    log.info(traceId, "file.patch.completed", { path: action.path, bytesWritten: byteLength(patched.data) });
    return {
      ok: true,
      code: "FILE_PATCHED",
      summary: "Text file patched.",
      data: { path: action.path, bytesWritten: byteLength(patched.data) },
    };
  }

  private validateTextWrite(content: string): ToolResult<never> | null {
    if (containsNul(content)) return failure("BINARY_CONTENT_REFUSED", "Binary writes are not supported.");
    if (byteLength(content) > MAX_WRITE_BYTES) {
      return failure("CONTENT_TOO_LARGE", `Text writes are limited to ${MAX_WRITE_BYTES} bytes.`);
    }
    return null;
  }

  private readTextForMutation(target: string): string {
    if (!fs.existsSync(target)) throw new Error(`File does not exist: ${target}`);
    if (!fs.statSync(target).isFile()) throw new Error(`Path is not a file: ${target}`);
    const buffer = fs.readFileSync(target);
    if (buffer.length > MAX_WRITE_BYTES) throw new Error(`File exceeds ${MAX_WRITE_BYTES} byte mutation limit.`);
    if (containsNul(buffer)) throw new Error(`Binary file mutation refused: ${target}`);
    return buffer.toString("utf8");
  }

  private atomicWrite(target: string, content: string): void {
    const parent = path.dirname(target);
    const mode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : 0o600;
    const temporary = path.join(parent, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode });
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
