"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolRegistry = void 0;
exports.registerTool = registerTool;
const BUILTIN_NAMES = new Set(["computer", "browser", "command.run"]);
const BUILTIN_PREFIXES = ["command.", "file.", "web."];
function isBuiltinName(name) {
    return BUILTIN_NAMES.has(name) || BUILTIN_PREFIXES.some((prefix) => name.startsWith(prefix));
}
/**
 * Source-managed registry of custom tools (ADR 0017 P1.1).
 *
 * Tools are registered explicitly via {@link registerTool}; there is no
 * directory scan, dynamic import, or drop-in plugin loading. The registry is
 * empty by default, so when no custom tools are registered the executor and
 * gateway behave exactly as before.
 */
class ToolRegistry {
    tools = new Map();
    register(tool) {
        const name = tool.definition.name;
        if (!name)
            throw new Error("Custom tool definition must declare a name.");
        if (isBuiltinName(name))
            throw new Error(`Custom tool name collides with a built-in tool: ${name}`);
        if (this.tools.has(name))
            throw new Error(`Tool already registered: ${name}`);
        this.tools.set(name, tool);
    }
    get(name) {
        return this.tools.get(name);
    }
    definitions() {
        return [...this.tools.values()].map((tool) => tool.definition);
    }
    /** Test-only: clear all registrations for isolation between test files. */
    clear() {
        this.tools.clear();
    }
}
exports.toolRegistry = new ToolRegistry();
function registerTool(tool) {
    exports.toolRegistry.register(tool);
}
