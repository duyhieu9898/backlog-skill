"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinuxX11DesktopAdapter = exports.UnavailableDesktopAdapter = void 0;
exports.getDesktopAdapter = getDesktopAdapter;
const contracts_1 = require("./contracts");
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
class UnavailableDesktopAdapter {
    getStatus() {
        return {
            platform: process.platform,
            capabilities: contracts_1.desktopCapabilities.map((capability) => ({
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
exports.UnavailableDesktopAdapter = UnavailableDesktopAdapter;
function commandAvailable(command) {
    return (0, node_child_process_1.spawnSync)(command, ["--version"], { stdio: "ignore" }).status === 0;
}
class LinuxX11DesktopAdapter {
    captureAvailable;
    launchAvailable;
    constructor() {
        const x11 = process.env.XDG_SESSION_TYPE === "x11" && Boolean(process.env.DISPLAY);
        this.captureAvailable = x11 && commandAvailable("gdbus") && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
        this.launchAvailable = x11 && commandAvailable("gtk-launch");
    }
    getStatus() {
        const display = process.env.DISPLAY || "";
        return {
            platform: process.platform,
            capabilities: [
                { capability: "screen.capture", available: this.captureAvailable, permission: { state: this.captureAvailable ? "granted" : "unavailable", detail: this.captureAvailable ? "GNOME Shell D-Bus" : "Requires X11, DBUS_SESSION_BUS_ADDRESS, and gdbus." } },
                { capability: "app.launch", available: this.launchAvailable, permission: { state: this.launchAvailable ? "granted" : "unavailable", detail: this.launchAvailable ? "gtk-launch desktop-file backend" : "Requires X11 and gtk-launch." } },
                { capability: "ui.observe", available: false, permission: { state: "unavailable" } },
                { capability: "ui.act", available: false, permission: { state: "unavailable" } },
            ],
            displays: this.captureAvailable ? [{ id: display, width: 0, height: 0, scaleFactor: 1 }] : [],
        };
    }
    capture(displayId) {
        const display = process.env.DISPLAY || "";
        if (!this.captureAvailable || (displayId && displayId !== display))
            throw new Error("Screen capture is unavailable.");
        const file = node_path_1.default.join(node_os_1.default.tmpdir(), `my-agent-screen-${Date.now()}.png`);
        const result = (0, node_child_process_1.spawnSync)("gdbus", ["call", "--session", "--dest", "org.gnome.Shell", "--object-path", "/org/gnome/Shell/Screenshot", "--method", "org.gnome.Shell.Screenshot.Screenshot", "false", "false", file], { encoding: "utf8" });
        if (result.status !== 0 || !node_fs_1.default.existsSync(file))
            throw new Error(result.stderr.trim() || "GNOME Shell screenshot failed.");
        return { path: file, displayId: display };
    }
    launch(appId) {
        if (!this.launchAvailable || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.desktop$/.test(appId))
            throw new Error("Reviewed desktop app launch is unavailable.");
        const child = (0, node_child_process_1.spawn)("gtk-launch", [appId], { detached: true, stdio: "ignore" });
        child.unref();
        return { appId };
    }
}
exports.LinuxX11DesktopAdapter = LinuxX11DesktopAdapter;
function getDesktopAdapter() {
    if (process.platform === "linux" && process.env.XDG_SESSION_TYPE === "x11")
        return new LinuxX11DesktopAdapter();
    return new UnavailableDesktopAdapter();
}
