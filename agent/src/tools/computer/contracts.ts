export const desktopCapabilities = [
  "screen.capture",
  "app.launch",
  "ui.observe",
  "ui.act",
] as const;

export type DesktopCapability = (typeof desktopCapabilities)[number];
export type DesktopPermissionState = "granted" | "denied" | "unavailable" | "unknown";

export type DesktopPermission = {
  state: DesktopPermissionState;
  detail?: string;
};

export type DesktopCapabilityStatus = {
  capability: DesktopCapability;
  available: boolean;
  permission: DesktopPermission;
};

export type DisplayInfo = {
  id: string;
  width: number;
  height: number;
  scaleFactor: number;
};

export type DesktopStatus = {
  platform: NodeJS.Platform;
  capabilities: DesktopCapabilityStatus[];
  displays: DisplayInfo[];
};

export type DesktopAppDefinition = {
  id: string;
  label: string;
};

export interface DesktopAdapter {
  getStatus(): DesktopStatus;
}

export type CapturedScreen = { path: string; displayId: string };
export type LaunchedApp = { appId: string };
export type FocusedWindow = { windowId: string; title: string };

export interface DesktopActionAdapter extends DesktopAdapter {
  capture(displayId?: string): CapturedScreen;
  launch(appId: string): LaunchedApp;
  /** Focus an already configured app window; undefined means it is not ready. */
  focusWindow(title: string): FocusedWindow | undefined;
}

export type DesktopEventOutcome = "available" | "unavailable" | "denied" | "confirmed" | "completed" | "failed";

export type DesktopEventEnvelope = {
  component: "desktop";
  action: string;
  outcome: DesktopEventOutcome;
  artifactId?: string;
  workflowId?: string;
  reasonCode?: string;
};
