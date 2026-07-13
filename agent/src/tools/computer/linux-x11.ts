import {
  desktopCapabilities,
  type CapturedScreen,
  type DesktopActionAdapter,
  type DesktopAdapter,
  type DesktopStatus,
  type FocusedWindow,
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

export function xdotoolWindowSearchArgs(title: string): string[] {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return ["search", "--onlyvisible", "--name", `^${escaped}$`];
}

export class LinuxX11DesktopAdapter implements DesktopActionAdapter {
  private readonly captureAvailable: boolean;
  private readonly launchAvailable: boolean;
  private readonly controlAvailable: boolean;

  constructor() {
    const x11 = process.env.XDG_SESSION_TYPE === "x11" && Boolean(process.env.DISPLAY);
    this.captureAvailable = x11 && commandAvailable("scrot");
    this.launchAvailable = x11 && commandAvailable("gtk-launch");
    this.controlAvailable = x11 && commandAvailable("xdotool");
  }

  getStatus(): DesktopStatus {
    const display = process.env.DISPLAY || "";
    return {
      platform: process.platform,
      capabilities: [
        { capability: "screen.capture", available: this.captureAvailable, permission: { state: this.captureAvailable ? "granted" : "unavailable", detail: this.captureAvailable ? "scrot X11 backend" : "Requires X11, DISPLAY, and scrot." } },
        { capability: "app.launch", available: this.launchAvailable, permission: { state: this.launchAvailable ? "granted" : "unavailable", detail: this.launchAvailable ? "gtk-launch desktop-file backend" : "Requires X11 and gtk-launch." } },
        { capability: "ui.observe", available: false, permission: { state: "unavailable" } },
        { capability: "ui.act", available: this.controlAvailable, permission: { state: this.controlAvailable ? "granted" : "unavailable", detail: this.controlAvailable ? "xdotool X11 backend" : "Requires X11, DISPLAY, and xdotool." } },
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

  focusWindow(title: string): FocusedWindow | undefined {
    if (!this.controlAvailable || !title.trim()) return undefined;
    const search = spawnSync("xdotool", xdotoolWindowSearchArgs(title), { encoding: "utf8" });
    if (search.status !== 0) return undefined;
    const windowId = search.stdout.trim().split(/\s+/).at(-1);
    if (!windowId || !/^\d+$/.test(windowId)) return undefined;
    const activate = spawnSync("xdotool", ["windowactivate", "--sync", windowId], { encoding: "utf8" });
    if (activate.status !== 0) return undefined;
    const name = spawnSync("xdotool", ["getwindowname", windowId], { encoding: "utf8" });
    const focusedTitle = name.status === 0 ? name.stdout.trim() : title;
    return { windowId, title: focusedTitle || title };
  }
}

export function getDesktopAdapter(): DesktopAdapter {
  if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "x11") return new LinuxX11DesktopAdapter();
  return new UnavailableDesktopAdapter();
}
