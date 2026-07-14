import { registerTool } from "./registry";

let bootstrapped = false;

/**
 * Single source-managed registration point for custom tools (ADR 0017 P1.1).
 *
 * Idempotent: safe to call repeatedly. There is deliberately no directory scan,
 * dynamic import, or drop-in plugin loading. Custom tools are registered with
 * explicit registerTool(...) calls here, then resolved and authorized through
 * ToolGateway before ToolExecutor invokes them.
 */
export function ensureToolsRegistered(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  // P1.1: no custom tools are registered yet. Future tools call:
  //   registerTool({ definition, risk, prepare, execute });
}
