"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveBrowserProfile = resolveBrowserProfile;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const errors_1 = require("./errors");
const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function resolveBrowserProfile(profileName, config) {
    if (!profileName || !PROFILE_NAME_PATTERN.test(profileName)) {
        throw new errors_1.BrowserError("PROFILE_INVALID_NAME", `Invalid profile name: "${profileName || ""}"`);
    }
    const profilesRootRaw = config.profilesRoot || "~/.my-agent/browser/profiles";
    const profilesRoot = profilesRootRaw.startsWith("~/")
        ? node_path_1.default.join(node_os_1.default.homedir(), profilesRootRaw.slice(2))
        : node_path_1.default.resolve(profilesRootRaw);
    const profileConfig = config.profiles?.[profileName] || {};
    const persistent = profileConfig.persistent ?? config.defaultPersistent ?? true;
    let profileDir;
    if (!persistent) {
        // Generate a temporary folder name inside profilesRoot to avoid collision and make it cleanable
        const randomId = node_crypto_1.default.randomBytes(8).toString("hex");
        profileDir = node_path_1.default.join(profilesRoot, `tmp_${profileName}_${randomId}`);
    }
    else {
        profileDir = node_path_1.default.join(profilesRoot, profileName);
    }
    // Canonicalize path safety
    const resolvedProfilesRoot = node_path_1.default.resolve(profilesRoot);
    const resolvedProfilePath = node_path_1.default.resolve(profileDir);
    // Assert it starts with resolvedProfilesRoot + path.sep
    if (!resolvedProfilePath.startsWith(resolvedProfilesRoot + node_path_1.default.sep)) {
        throw new errors_1.BrowserError("PROFILE_PATH_OUTSIDE_ROOT", `Profile path "${resolvedProfilePath}" escapes root "${resolvedProfilesRoot}"`);
    }
    // Securely resolve real paths if they exist
    try {
        node_fs_1.default.mkdirSync(resolvedProfilesRoot, { recursive: true });
        const realProfilesRoot = node_fs_1.default.realpathSync(resolvedProfilesRoot);
        // Create profile dir to verify its real path
        node_fs_1.default.mkdirSync(resolvedProfilePath, { recursive: true });
        const realProfilePath = node_fs_1.default.realpathSync(resolvedProfilePath);
        if (!realProfilePath.startsWith(realProfilesRoot + node_path_1.default.sep)) {
            throw new errors_1.BrowserError("PROFILE_PATH_OUTSIDE_ROOT", `Profile real path "${realProfilePath}" escapes root "${realProfilesRoot}"`);
        }
    }
    catch (err) {
        if (err instanceof errors_1.BrowserError) {
            throw err;
        }
        throw new errors_1.BrowserError("PROFILE_START_FAILED", `Failed to resolve and secure profile path: ${err.message}`);
    }
    return {
        name: profileName,
        persistent,
        userDataDir: resolvedProfilePath,
    };
}
