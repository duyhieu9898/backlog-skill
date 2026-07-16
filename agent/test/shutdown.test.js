// Proves ADR 0017 P2.3: the graceful shutdown sequence extracted into
// `core/shutdown.ts` runs its steps in the production order (scheduler →
// command → browser) and short-circuits the command-wait when no command is
// running. `bot.ts` is a process entry point with top-level side effects, so
// the orchestration is tested here through injected dependencies.

const assert = require("node:assert/strict");
const test = require("node:test");

const { performGracefulShutdown } = require("../dist/core/shutdown");

test("runs scheduler, command, and browser shutdown in order when a command is running", async () => {
  const calls = [];

  const result = await performGracefulShutdown({
    scheduler: { stop() { calls.push("scheduler.stop"); } },
    stopRunningCommand: () => {
      calls.push("stopRunningCommand");
      return { stopped: true, traceId: "t1" };
    },
    waitForRunningCommandStop: async () => { calls.push("waitForRunningCommandStop"); },
    browserShutdown: async () => { calls.push("browserShutdown"); return { closedProfiles: 2 }; },
  });

  assert.deepEqual(calls, ["scheduler.stop", "stopRunningCommand", "waitForRunningCommandStop", "browserShutdown"]);
  assert.equal(result.schedulerStopped, true);
  assert.equal(result.commandStopped, true);
  assert.equal(result.commandTraceId, "t1");
  assert.deepEqual(result.browserShutdown, { closedProfiles: 2 });
});

test("skips waitForRunningCommandStop when no command is running", async () => {
  const calls = [];

  const result = await performGracefulShutdown({
    scheduler: { stop() { calls.push("scheduler.stop"); } },
    stopRunningCommand: () => {
      calls.push("stopRunningCommand");
      return { stopped: false };
    },
    waitForRunningCommandStop: async () => { calls.push("waitForRunningCommandStop"); },
    browserShutdown: async () => { calls.push("browserShutdown"); },
  });

  assert.deepEqual(calls, ["scheduler.stop", "stopRunningCommand", "browserShutdown"]);
  assert.equal(result.commandStopped, false);
});

test("tolerates a null scheduler", async () => {
  const calls = [];

  const result = await performGracefulShutdown({
    scheduler: null,
    stopRunningCommand: () => { calls.push("stopRunningCommand"); return { stopped: false }; },
    waitForRunningCommandStop: async () => { calls.push("waitForRunningCommandStop"); },
    browserShutdown: async () => { calls.push("browserShutdown"); },
  });

  assert.deepEqual(calls, ["stopRunningCommand", "browserShutdown"]);
  assert.equal(result.schedulerStopped, false);
});

test("propagates a browser shutdown failure to the caller", async () => {
  await assert.rejects(
    performGracefulShutdown({
      scheduler: null,
      stopRunningCommand: () => ({ stopped: false }),
      waitForRunningCommandStop: async () => {},
      browserShutdown: async () => { throw new Error("browser shutdown boom"); },
    }),
    /browser shutdown boom/,
  );
});
