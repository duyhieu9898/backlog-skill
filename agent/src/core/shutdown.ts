/**
 * Graceful process shutdown, extracted from `bot.ts` so the ordering and
 * short-circuit behavior can be exercised in isolation.
 *
 * The order mirrors the production wiring: stop the scheduler first, then
 * request the active command process group to terminate (waiting for it only
 * when one was actually running), then tear down browser resources. Extracting
 * these three steps behind injected dependencies keeps `bot.ts` as a thin
 * entry point and lets tests verify the sequence without process-level side
 * effects.
 */

export type ShutdownDeps = {
  scheduler?: { stop(): void } | null;
  stopRunningCommand: () => { stopped: boolean; traceId?: string };
  waitForRunningCommandStop: (timeoutMs?: number) => Promise<void>;
  browserShutdown: () => Promise<unknown>;
};

export type ShutdownResult = {
  schedulerStopped: boolean;
  commandStopped: boolean;
  commandTraceId?: string;
  browserShutdown: unknown;
};

export async function performGracefulShutdown(deps: ShutdownDeps): Promise<ShutdownResult> {
  const result: ShutdownResult = { schedulerStopped: false, commandStopped: false, browserShutdown: undefined };

  if (deps.scheduler) {
    deps.scheduler.stop();
    result.schedulerStopped = true;
  }

  const stopped = deps.stopRunningCommand();
  if (stopped.stopped) {
    result.commandStopped = true;
    result.commandTraceId = stopped.traceId;
    await deps.waitForRunningCommandStop();
  }

  result.browserShutdown = await deps.browserShutdown();
  return result;
}
