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
  executable: string;
  args: string[];
  cwd: string;
  requiresConfirmation: boolean;
  externalSideEffect: boolean;
};

export type ToolAction = FileToolAction | CommandRunAction;

export type PolicyReasonCode =
  | "ALLOWED"
  | "CONFIRMATION_REQUIRED"
  | "DENIED_PATH"
  | "OUTSIDE_READ_ROOTS"
  | "OUTSIDE_WRITE_ROOTS"
  | "OUTSIDE_WORKSPACE"
  | "INVALID_PATH";

export type NormalizedToolAction =
  | FileToolAction
  | CommandRunAction;

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
