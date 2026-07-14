import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { BrowserError } from "./errors";
import type { BrowserResourceConfig } from "../config/app";

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export type ResolvedBrowserProfile = {
  name: string;
  persistent: boolean;
  userDataDir: string;
};

export function resolveBrowserProfile(
  profileName: string,
  config: BrowserResourceConfig,
): ResolvedBrowserProfile {
  if (!profileName || !PROFILE_NAME_PATTERN.test(profileName)) {
    throw new BrowserError("PROFILE_INVALID_NAME", `Invalid profile name: "${profileName || ""}"`);
  }

  const profilesRootRaw = config.profilesRoot || "~/.my-agent/browser/profiles";
  const profilesRoot = profilesRootRaw.startsWith("~/")
    ? path.join(os.homedir(), profilesRootRaw.slice(2))
    : path.resolve(profilesRootRaw);

  const profileConfig = config.profiles?.[profileName] || {};
  const persistent = profileConfig.persistent ?? config.defaultPersistent ?? true;

  let profileDir: string;
  if (!persistent) {
    // Generate a temporary folder name inside profilesRoot to avoid collision and make it cleanable
    const randomId = crypto.randomBytes(8).toString("hex");
    profileDir = path.join(profilesRoot, `tmp_${profileName}_${randomId}`);
  } else {
    profileDir = path.join(profilesRoot, profileName);
  }

  // Canonicalize path safety
  const resolvedProfilesRoot = path.resolve(profilesRoot);
  const resolvedProfilePath = path.resolve(profileDir);

  // Assert it starts with resolvedProfilesRoot + path.sep
  if (!resolvedProfilePath.startsWith(resolvedProfilesRoot + path.sep)) {
    throw new BrowserError("PROFILE_PATH_OUTSIDE_ROOT", `Profile path "${resolvedProfilePath}" escapes root "${resolvedProfilesRoot}"`);
  }

  // Securely resolve real paths if they exist
  try {
    fs.mkdirSync(resolvedProfilesRoot, { recursive: true });
    const realProfilesRoot = fs.realpathSync(resolvedProfilesRoot);

    // Create profile dir to verify its real path
    fs.mkdirSync(resolvedProfilePath, { recursive: true });
    const realProfilePath = fs.realpathSync(resolvedProfilePath);

    if (!realProfilePath.startsWith(realProfilesRoot + path.sep)) {
      throw new BrowserError("PROFILE_PATH_OUTSIDE_ROOT", `Profile real path "${realProfilePath}" escapes root "${realProfilesRoot}"`);
    }
  } catch (err: any) {
    if (err instanceof BrowserError) {
      throw err;
    }
    throw new BrowserError("PROFILE_START_FAILED", `Failed to resolve and secure profile path: ${err.message}`);
  }

  return {
    name: profileName,
    persistent,
    userDataDir: resolvedProfilePath,
  };
}
