import {
  desktopCapabilities,
  type DesktopAdapter,
  type DesktopStatus,
} from "./contracts";

export class UnavailableDesktopAdapter implements DesktopAdapter {
  getStatus(): DesktopStatus {
    return {
      platform: process.platform,
      capabilities: desktopCapabilities.map((capability) => ({
        capability,
        available: false,
        permission: {
          state: "unavailable",
          detail: "No reviewed desktop adapter is installed.",
        },
      })),
      displays: [],
    };
  }
}

export function getDesktopAdapter(): DesktopAdapter {
  return new UnavailableDesktopAdapter();
}
