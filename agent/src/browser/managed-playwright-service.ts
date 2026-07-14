import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { chromium, type BrowserContext } from "playwright";
import type { ShutdownOptions, BrowserShutdownResult } from "./browser-service";
import { BaseBrowserService } from "./base-browser-service";
import { loadAgentConfig } from "../config/app";
import { BrowserError } from "./errors";
import { resolveBrowserProfile } from "./profile-path";
import type { BrowserProfileState } from "./profile-registry";
import { refStore } from "./ref-store";
import { evaluateUrl } from "./url-policy";

export function findChromiumPid(userDataDir: string): number | undefined {
  try {
    if (process.platform === "win32") {
      const output = execSync('wmic process where "CommandLine like \'%' + userDataDir.replace(/\\/g, '\\\\') + '%\'" get ProcessId').toString();
      const lines = output.split("\r\n");
      for (const line of lines) {
        const pid = parseInt(line.trim(), 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    } else {
      const output = execSync("ps -ef").toString();
      const lines = output.split("\n");
      for (const line of lines) {
        if (line.includes(userDataDir) && (line.includes("chrome") || line.includes("Chromium"))) {
          const parts = line.trim().split(/\s+/);
          const pid = parseInt(parts[1], 10);
          if (!isNaN(pid) && pid > 0) return pid;
        }
      }
    }
  } catch (e) {
    // Ignore error
  }
  return undefined;
}

export function checkProfileLock(profileName: string, userDataDir: string): void {
  // 1. Linux/macOS SingletonLock
  const lockPath = path.join(userDataDir, "SingletonLock");
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(lockPath);
      const parts = target.split("-");
      const pidStr = parts[parts.length - 1];
      const pid = parseInt(pidStr, 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0);
          throw new BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use by process ${pid}`);
        } catch (err: any) {
          if (err.code === "EPERM") {
            throw new BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use by process ${pid}`);
          }
          // Process is dead: let Chromium handle recovery
        }
      }
    }
  } catch (e) {
    if (e instanceof BrowserError) throw e;
  }

  // 2. Windows lockfile
  const winLockPath = path.join(userDataDir, "lockfile");
  if (fs.existsSync(winLockPath)) {
    try {
      const fd = fs.openSync(winLockPath, "r+");
      fs.closeSync(fd);
    } catch (err: any) {
      if (err.code === "EBUSY" || err.code === "EPERM") {
        throw new BrowserError("PROFILE_ALREADY_IN_USE", `Profile "${profileName}" is already in use (locked file)`);
      }
    }
  }
}

export class ManagedPlaywrightBrowserService extends BaseBrowserService {
  async start(profileName?: string): Promise<{ running: boolean; profile: string }> {
    if (this.shutdownStarted) {
      throw new BrowserError("BROWSER_SHUTTING_DOWN", "Browser service is shutting down");
    }

    const resolvedName = this.resolveProfileName(profileName);
    const release = await this.profileRegistry.getLock(resolvedName).acquire();

    try {
      const existing = this.profileRegistry.get(resolvedName);
      if (existing) {
        if (existing.status === "running") {
          return { running: true, profile: resolvedName };
        }
        if (existing.status === "starting") {
          return { running: true, profile: resolvedName };
        }
      }

      const config = loadAgentConfig();
      const profile = resolveBrowserProfile(resolvedName, config.browser || {});

      checkProfileLock(profile.name, profile.userDataDir);

      const state: BrowserProfileState = {
        name: profile.name,
        persistent: profile.persistent,
        userDataDir: profile.userDataDir,
        status: "starting",
        activeOperationCount: 0,
        shutdownRequested: false,
        lastUsedAt: Date.now(),
      };
      this.profileRegistry.register(resolvedName, state);

      const browserConfig = config.browser || {};
      const headless = (browserConfig as any).headless !== false;

      const context = await chromium.launchPersistentContext(profile.userDataDir, {
        headless,
        viewport: { width: 1280, height: 800 },
      });

      // Register navigation guard
      await context.route("**/*", async (route, request) => {
        if (request.isNavigationRequest()) {
          const currentConfig = loadAgentConfig();
          const allowedHosts = currentConfig.permissions?.browser?.allowedHosts || [];
          const decision = await evaluateUrl({ url: request.url(), allowedHosts });
          if (decision.decision === "deny") {
            await route.abort("blockedbyclient");
            return;
          }
        }
        await route.continue();
      });

      state.context = context;
      state.status = "running";
      state.startedAt = Date.now();
      state.lastUsedAt = Date.now();

      // Find PID
      const pid = findChromiumPid(profile.userDataDir);
      if (pid) {
        state.browserProcess = { pid };
      }

      // Register any existing pages
      const pages = context.pages();
      for (const page of pages) {
        this.tabRegistry.register(page, context, resolvedName);
      }

      return { running: true, profile: resolvedName };
    } catch (err: any) {
      const state = this.profileRegistry.get(resolvedName);
      if (state) {
        state.status = "failed";
      }
      throw err;
    } finally {
      release();
    }
  }

  async stop(profileName?: string, options?: ShutdownOptions): Promise<void> {
    const resolvedName = this.resolveProfileName(profileName);
    const release = await this.profileRegistry.getLock(resolvedName).acquire();

    try {
      const state = this.profileRegistry.get(resolvedName);
      if (!state) return;

      state.status = "stopping";
      if (state.context) {
        try {
          await state.context.close();
        } catch (err: any) {
          console.error(`Failed to close browser context for profile ${resolvedName}:`, err);
        }
      }

      // Check process termination
      if (state.browserProcess?.pid) {
        const pid = state.browserProcess.pid;
        const config = loadAgentConfig();
        const forceKillTimeout = options?.forceKillTimeoutMs ?? config.browser?.shutdown?.forceKillTimeoutMs ?? 5000;
        
        let exited = false;
        const end = Date.now() + forceKillTimeout;
        while (Date.now() < end) {
          try {
            process.kill(pid, 0);
            await new Promise(r => setTimeout(r, 100));
          } catch (e: any) {
            if (e.code === "ESRCH") {
              exited = true;
              break;
            }
          }
        }

        if (!exited) {
          try {
            process.kill(pid, "SIGTERM");
          } catch (e) {}
          await new Promise(r => setTimeout(r, 500));
          try {
            process.kill(pid, 0);
            process.kill(pid, "SIGKILL");
          } catch (e) {}
        }
      }

      if (!state.persistent) {
        try {
          fs.rmSync(state.userDataDir, { recursive: true, force: true });
        } catch (err) {
          console.error(`Failed to delete ephemeral directory ${state.userDataDir}:`, err);
        }
      }

      state.status = "stopped";
      this.tabRegistry.clear(resolvedName);
      refStore.clearProfile(resolvedName);
      this.profileRegistry.remove(resolvedName);
    } finally {
      release();
    }
  }

  async shutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    this.shutdownPromise = this.performShutdown(options);
    return this.shutdownPromise;
  }

  private async performShutdown(options?: ShutdownOptions): Promise<BrowserShutdownResult> {
    const startedAt = Date.now();
    this.shutdownStarted = true;

    if (this.sweeper) {
      this.sweeper.stop();
    }

    const config = loadAgentConfig();
    const gracefulTimeout = options?.gracefulTimeoutMs ?? config.browser?.shutdown?.gracefulTimeoutMs ?? 10000;
    const forceKillTimeout = options?.forceKillTimeoutMs ?? config.browser?.shutdown?.forceKillTimeoutMs ?? 5000;

    const closedProfiles: string[] = [];
    const forcedProfiles: string[] = [];
    const errors: Array<{ profileName: string; code: string; message: string }> = [];

    const activeProfiles = this.profileRegistry.list();

    // 1. Wait for active operations to complete
    const graceEnd = Date.now() + gracefulTimeout;
    while (Date.now() < graceEnd) {
      const busy = activeProfiles.some(p => p.activeOperationCount > 0);
      if (!busy) break;
      await new Promise(r => setTimeout(r, 100));
    }

    // 2. Stop and kill
    for (const p of activeProfiles) {
      const release = await this.profileRegistry.getLock(p.name).acquire();
      try {
        p.status = "stopping";
        p.shutdownRequested = true;

        if (p.context) {
          try {
            await p.context.close();
            closedProfiles.push(p.name);
          } catch (err: any) {
            errors.push({ profileName: p.name, code: "PROFILE_CLOSE_FAILED", message: err.message });
          }
        }

        if (!p.persistent && p.userDataDir) {
          try {
            fs.rmSync(p.userDataDir, { recursive: true, force: true });
          } catch (e) {}
        }

        if (p.browserProcess?.pid) {
          const pid = p.browserProcess.pid;
          let exited = false;
          const end = Date.now() + forceKillTimeout;
          while (Date.now() < end) {
            try {
              process.kill(pid, 0);
              await new Promise(r => setTimeout(r, 100));
            } catch (err: any) {
              if (err.code === "ESRCH") {
                exited = true;
                break;
              }
            }
          }

          if (!exited) {
            try {
              process.kill(pid, "SIGTERM");
            } catch (e) {}
            await new Promise(r => setTimeout(r, 500));
            try {
              process.kill(pid, 0);
              process.kill(pid, "SIGKILL");
              forcedProfiles.push(p.name);
            } catch (err: any) {
              if (err.code === "ESRCH") {
                closedProfiles.push(p.name);
              } else {
                errors.push({ profileName: p.name, code: "BROWSER_FORCE_KILL_FAILED", message: `Failed to SIGKILL process ${pid}` });
              }
            }
          }
        }

        p.status = "stopped";
        this.tabRegistry.clear(p.name);
        refStore.clearProfile(p.name);
        this.profileRegistry.remove(p.name);
      } finally {
        release();
      }
    }

    return {
      startedAt,
      completedAt: Date.now(),
      closedProfiles,
      forcedProfiles,
      errors,
    };
  }
}
