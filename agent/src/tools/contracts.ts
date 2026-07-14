export type FileReadAction = {
  kind: "file.read";
  path: string;
  maxBytes?: number;
};

export type FileListAction = {
  kind: "file.list";
  path: string;
  maxEntries?: number;
};

export type FileExistsAction = {
  kind: "file.exists";
  path: string;
};

export type FileMkdirAction = {
  kind: "file.mkdir";
  path: string;
};

export type FileWriteAction = {
  kind: "file.write";
  path: string;
  content: string;
};

export type FilePatchAction = {
  kind: "file.patch";
  path: string;
  search: string;
  replacement: string;
};

export type FileReadOnlyAction = FileReadAction | FileListAction | FileExistsAction;
export type FileMutationAction = FileMkdirAction | FileWriteAction | FilePatchAction;
export type FileToolAction = FileReadOnlyAction | FileMutationAction;

export type CommandRunAction = {
  kind: "command.run";
  commandId: string;
  executable?: string;
  args?: string[];
  shellCommand?: string;
  cwd: string;
  requiresConfirmation: boolean;
  externalSideEffect: boolean;
};

export type DesktopCaptureAction = {
  kind: "desktop.capture";
  displayId?: string;
};

export type DesktopLaunchAction = {
  kind: "desktop.launch";
  appId: string;
};

export type DesktopObserveAction = {
  kind: "desktop.observe";
  displayId?: string;
};

export type DesktopActAction = {
  kind: "desktop.act";
  targetId: string;
  operation: "click" | "type" | "key" | "scroll";
};

import type { BrowserActionRequest } from "../browser/types";

export type BrowserToolAction =
  | { kind: "browser.status"; profile?: string }
  | { kind: "browser.start"; profile?: string }
  | { kind: "browser.stop"; profile?: string }
  | { kind: "browser.tabs"; profile?: string }
  | { kind: "browser.open"; profile?: string; url: string }
  | { kind: "browser.focus"; profile?: string; targetId: string }
  | { kind: "browser.close"; profile?: string; targetId: string }
  | { kind: "browser.navigate"; profile?: string; targetId: string; url: string }
  | { kind: "browser.snapshot"; profile?: string; targetId: string }
  | { kind: "browser.act"; profile?: string; targetId: string; request: BrowserActionRequest }
  | { kind: "browser.screenshot"; profile?: string; targetId: string; fullPage?: boolean; ref?: string };

export type DesktopToolAction =
  | DesktopCaptureAction
  | DesktopLaunchAction
  | DesktopObserveAction
  | DesktopActAction;

export type ToolAction = FileToolAction | CommandRunAction | DesktopToolAction | BrowserToolAction;

export function isDesktopToolAction(action: ToolAction | NormalizedToolAction): action is DesktopToolAction {
  return action.kind.startsWith("desktop.");
}

export function isBrowserToolAction(action: ToolAction | NormalizedToolAction): action is BrowserToolAction {
  return action.kind.startsWith("browser.");
}

export type PolicyReasonCode =
  | "ALLOWED"
  | "CONFIRMATION_REQUIRED"
  | "DENIED_PATH"
  | "OUTSIDE_READ_ROOTS"
  | "OUTSIDE_WRITE_ROOTS"
  | "OUTSIDE_WORKSPACE"
  | "INVALID_PATH"
  | "DESKTOP_CAPABILITY_UNAVAILABLE"
  | "DESKTOP_PERMISSION_DENIED"
  | "UNDECLARED_DESKTOP_APP"
  | "UNKNOWN_DISPLAY";

export type NormalizedToolAction =
  | FileToolAction
  | CommandRunAction
  | DesktopToolAction
  | BrowserToolAction;

export type PolicyDecision =
  | {
      outcome: "allow" | "confirm";
      reasonCode: "ALLOWED" | "CONFIRMATION_REQUIRED";
      reason: string;
      action: NormalizedToolAction;
    }
  | {
      outcome: "deny";
      reasonCode: Exclude<PolicyReasonCode, "ALLOWED" | "CONFIRMATION_REQUIRED">;
      reason: string;
      action: NormalizedToolAction;
    };

export type ToolResult<T = unknown> = {
  ok: boolean;
  code: string;
  summary: string;
  data?: T;
};
