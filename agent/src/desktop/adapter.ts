import {
  desktopCapabilities,
  type CapturedScreen,
  type DesktopActionAdapter,
  type DesktopAdapter,
  type DesktopStatus,
  type LaunchedApp,
} from "./contracts";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function commandAvailable(command: string): boolean {
  const args = command === "gdbus" ? ["help"] : ["--version"];
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

export function scrotScreenshotArgs(file: string): string[] {
  return ["-o", file];
}

export class LinuxX11DesktopAdapter implements DesktopActionAdapter {
  private readonly captureAvailable: boolean;
  private readonly launchAvailable: boolean;

  constructor() {
    const x11 = process.env.XDG_SESSION_TYPE === "x11" && Boolean(process.env.DISPLAY);
    this.captureAvailable = x11 && commandAvailable("scrot");
    this.launchAvailable = x11 && commandAvailable("gtk-launch");
  }

  getStatus(): DesktopStatus {
    const display = process.env.DISPLAY || "";
    return {
      platform: process.platform,
      capabilities: [
        { capability: "screen.capture", available: this.captureAvailable, permission: { state: this.captureAvailable ? "granted" : "unavailable", detail: this.captureAvailable ? "scrot X11 backend" : "Requires X11, DISPLAY, and scrot." } },
        { capability: "app.launch", available: this.launchAvailable, permission: { state: this.launchAvailable ? "granted" : "unavailable", detail: this.launchAvailable ? "gtk-launch desktop-file backend" : "Requires X11 and gtk-launch." } },
        { capability: "ui.observe", available: false, permission: { state: "unavailable" } },
        { capability: "ui.act", available: false, permission: { state: "unavailable" } },
      ],
      displays: this.captureAvailable ? [{ id: display, width: 0, height: 0, scaleFactor: 1 }] : [],
    };
  }

  capture(displayId?: string): CapturedScreen {
    const display = process.env.DISPLAY || "";
    if (!this.captureAvailable || (displayId && displayId !== display)) throw new Error("Screen capture is unavailable.");
    const file = path.join(os.tmpdir(), `my-agent-screen-${Date.now()}.png`);
    const result = spawnSync("scrot", scrotScreenshotArgs(file), { encoding: "utf8" });
    if (result.status !== 0 || !fs.existsSync(file)) throw new Error(result.stderr.trim() || "X11 screenshot failed.");
    return { path: file, displayId: display };
  }

  launch(appId: string): LaunchedApp {
    if (!this.launchAvailable || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/.test(appId)) throw new Error("Reviewed desktop app launch is unavailable.");
    const child = spawn("gtk-launch", [appId], { detached: true, stdio: "ignore" });
    child.unref();
    return { appId };
  }
}

export function getDesktopAdapter(): DesktopAdapter {
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "x11") return new LinuxX11DesktopAdapter();
  return new UnavailableDesktopAdapter();
}
