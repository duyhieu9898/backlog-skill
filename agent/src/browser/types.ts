export type BrowserActionRequest =
  | {
      kind: 'click';
      ref: string;
      snapshotId: string;
    }
  | {
      kind: 'fill';
      ref: string;
      value: string;
      snapshotId: string;
    }
  | {
      kind: 'type';
      ref: string;
      text: string;
      snapshotId: string;
    }
  | {
      kind: 'press';
      key: string;
    }
  | {
      kind: 'select';
      ref: string;
      value: string;
      snapshotId: string;
    }
  | {
      kind: 'scroll';
      direction: 'up' | 'down';
      amount?: number;
    }
  | {
      kind: 'wait';
      milliseconds?: number;
    };

/**
 * Structured action outcome. Mutation magnitude describes how much the
 * document changed; ref freshness tells the model whether prior refs are
 * still usable; nextSnapshotRequired signals that the model must capture a
 * fresh snapshot before its next ref action.
 */
export type MutationMagnitude =
  | 'none'
  | 'minor-dom'
  | 'major-dom'
  | 'navigation'
  | 'frame-navigation'
  | 'tab-replacement';

export type RefFreshness = 'still-valid' | 'possibly-stale' | 'invalid';

export type BrowserActionOutcome = {
  mutationMagnitude: MutationMagnitude;
  refFreshness: RefFreshness;
  nextSnapshotRequired: boolean;
};

/** Runtime validation for the provider-facing browser action envelope. */
export function validateBrowserActionRequest(value: unknown): BrowserActionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser action must be an object.");
  const action = value as Record<string, unknown>;
  if (typeof action.kind !== "string") throw new Error("Browser action kind is required.");
  const requireText = (key: string) => {
    if (typeof action[key] !== "string" || !action[key]) throw new Error(`Browser ${action.kind} requires ${key}.`);
  };
  if (["click", "fill", "type", "select"].includes(action.kind)) {
    requireText("ref");
    requireText("snapshotId");
    if (action.kind === "fill" || action.kind === "select") requireText("value");
    if (action.kind === "type") requireText("text");
  } else if (action.kind === "press") {
    requireText("key");
  } else if (action.kind === "scroll") {
    if (action.direction !== "up" && action.direction !== "down") throw new Error("Browser scroll requires direction up or down.");
  } else if (action.kind === "wait") {
    if (action.milliseconds !== undefined && (!Number.isInteger(action.milliseconds) || (action.milliseconds as number) < 0)) throw new Error("Browser wait milliseconds must be a non-negative integer.");
  } else {
    throw new Error(`Unsupported browser action: ${action.kind}`);
  }
  // Reject cross-variant fields: a ref action must not carry `key`, a press
  // must not carry `ref`/`snapshotId`, etc. This keeps provider-validation and
  // runtime-validation in lockstep (US-027 AC).
  const allowedPerKind: Record<string, readonly string[]> = {
    click: ["ref", "snapshotId"],
    fill: ["ref", "value", "snapshotId"],
    type: ["ref", "text", "snapshotId"],
    select: ["ref", "value", "snapshotId"],
    press: ["key"],
    scroll: ["direction", "amount"],
    wait: ["milliseconds"],
  };
  const allowed = allowedPerKind[action.kind];
  if (allowed) {
    for (const key of Object.keys(action)) {
      if (key !== "kind" && !allowed.includes(key)) {
        throw new Error(`Browser ${action.kind} does not accept "${key}".`);
      }
    }
  }
  return action as unknown as BrowserActionRequest;
}

export type BrowserTab = {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
};

export type BrowserSnapshot = {
  snapshotId: string;
  text: string;
};

export type BrowserArtifact = {
  id: string;
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg';
  path: string;
};

export type BrowserToolResult = {
  ok: boolean;
  browser?: {
    running: boolean;
    profile: string;
  };
  target?: {
    targetId: string;
    url: string;
    title: string;
  };
  tabs?: BrowserTab[];
  snapshot?: BrowserSnapshot;
  artifact?: BrowserArtifact;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};
