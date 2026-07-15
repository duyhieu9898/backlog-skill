"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRET_FILE_PATTERNS = void 0;
exports.isSecretLike = isSecretLike;
exports.isClearlyDestructiveCommand = isClearlyDestructiveCommand;
exports.needsSystemApproval = needsSystemApproval;
const node_path_1 = __importDefault(require("node:path"));
/**
 * Shared, side-effect-free classification primitives consumed by both
 * PermissionPolicy (decision) and actionProfile (grant matching). Kept in a
 * leaf module with only node builtins + types so neither consumer creates a
 * circular import.
 */
exports.SECRET_FILE_PATTERNS = [
    /^\.env(?:\..+)?$/i,
    /^(?:credentials?|secrets?)(?:\..+)?$/i,
    /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
    /\.(?:pem|key|p12|pfx)$/i,
];
function isSecretLike(candidate) {
    return exports.SECRET_FILE_PATTERNS.some((pattern) => pattern.test(node_path_1.default.basename(candidate)));
}
function isClearlyDestructiveCommand(action) {
    const command = [action.executable || "", ...(action.args || []), action.shellCommand || ""].join(" ").toLowerCase();
    return /\brm\s+-[^\n]*r[^\n]*\s+\/(?:\s|$)|\brm\s+-[^\n]*r[^\n]*\s+\/\*|\brm\s+-[^\n]*r[^\n]*\s+\/home(?:\s|$)|\bmkfs\b|\b(?:dd|cat)\b[^\n]*(?:of=)?\/dev\/(?:sd|nvme|vd)|\b(?:grub-install|update-grub)\b|\b(?:fork\s*bomb|:\(\)\s*\{\s*:\|:\s*&\s*\})|\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/.test(command);
}
function needsSystemApproval(action) {
    const executable = node_path_1.default.basename(action.executable || "").toLowerCase();
    const command = [action.executable || "", ...(action.args || []), action.shellCommand || ""].join(" ").toLowerCase();
    return executable === "sudo" || ["apt", "apt-get", "snap", "systemctl", "service", "dpkg", "rpm"].includes(executable)
        || /\b(?:sudo|apt(?:-get)?|snap|systemctl|service|dpkg|rpm)\b/.test(command);
}
