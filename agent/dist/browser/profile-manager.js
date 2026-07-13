"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileManager = void 0;
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const app_1 = require("../config/app");
class ProfileManager {
    resolve(profileName) {
        const config = (0, app_1.loadAgentConfig)();
        const browserConfig = config.browser || {};
        const name = profileName || browserConfig.defaultProfile || "agent";
        const profileSpec = browserConfig.profiles?.[name] || {};
        const mode = profileSpec.mode || "managed";
        const rawDir = profileSpec.userDataDir || `~/.my-agent/browser/profiles/${name}`;
        // Expand ~ home directory symbol
        const userDataDir = rawDir.startsWith("~/")
            ? node_path_1.default.join(node_os_1.default.homedir(), rawDir.slice(2))
            : node_path_1.default.resolve(rawDir);
        // Default headless to false if explicitly false, otherwise true
        const headless = browserConfig.headless !== false;
        return {
            name,
            mode,
            userDataDir,
            headless,
            endpoint: profileSpec.endpoint,
        };
    }
}
exports.ProfileManager = ProfileManager;
