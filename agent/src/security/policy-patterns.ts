import path from "node:path";

import type { CommandRunAction } from "../tools/contracts";

/**
 * Shared, side-effect-free classification primitives consumed by both
 * PermissionPolicy (decision) and actionProfile (grant matching). Kept in a
 * leaf module with only node builtins + types so neither consumer creates a
 * circular import.
 */

export const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /^(?:credentials?|secrets?)(?:\..+)?$/i,
  /^(?:id_rsa|id_ed25519)(?:\.pub)?$/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

export function isSecretLike(candidate: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path.basename(candidate)));
}

export function isClearlyDestructiveCommand(action: CommandRunAction): boolean {
  const command = [action.executable || "", ...(action.args || []), action.shellCommand || ""].join(" ").toLowerCase();
  return /\brm\s+-[^\n]*r[^\n]*\s+\/(?:\s|$)|\brm\s+-[^\n]*r[^\n]*\s+\/\*|\brm\s+-[^\n]*r[^\n]*\s+\/home(?:\s|$)|\bmkfs\b|\b(?:dd|cat)\b[^\n]*(?:of=)?\/dev\/(?:sd|nvme|vd)|\b(?:grub-install|update-grub)\b|\b(?:fork\s*bomb|:\(\)\s*\{\s*:\|:\s*&\s*\})|\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba)?sh\b/.test(command);
}

export function needsSystemApproval(action: CommandRunAction): boolean {
  const executable = path.basename(action.executable || "").toLowerCase();
  const command = [action.executable || "", ...(action.args || []), action.shellCommand || ""].join(" ").toLowerCase();
  return executable === "sudo" || ["apt", "apt-get", "snap", "systemctl", "service", "dpkg", "rpm"].includes(executable)
    || /\b(?:sudo|apt(?:-get)?|snap|systemctl|service|dpkg|rpm)\b/.test(command);
}
