import os from "node:os";
import path from "node:path";
import { loadAgentConfig } from "../config/app";

export type BrowserProfile = {
  name: string;
  mode: "managed" | "cdp";
  userDataDir: string;
  headless: boolean;
  endpoint?: string;
};

export class ProfileManager {
  resolve(profileName?: string): BrowserProfile {
    const config = loadAgentConfig();
    const browserConfig = (config as any).browser || {};
    const name = profileName || browserConfig.defaultProfile || "agent";

    const profileSpec = browserConfig.profiles?.[name] || {};
    const mode = profileSpec.mode || "managed";
    const rawDir = profileSpec.userDataDir || `~/.my-agent/browser/profiles/${name}`;
    
    // Expand ~ home directory symbol
    const userDataDir = rawDir.startsWith("~/")
      ? path.join(os.homedir(), rawDir.slice(2))
      : path.resolve(rawDir);

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
