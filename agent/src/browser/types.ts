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
