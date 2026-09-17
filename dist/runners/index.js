import { createClaudeRunner } from "./claude.js";
import { createCodexRunner } from "./codex.js";
import { createCustomRunner } from "./custom.js";
export const BUILTIN_RUNNER_IDS = ["claude", "codex"];
/** Build the runner registry: built-ins (optionally overridden by config) plus custom config runners. */
export function createRunnerRegistry(config) {
    const registry = new Map();
    registry.set("claude", createClaudeRunner(config.runners.claude ?? {}));
    registry.set("codex", createCodexRunner(config.runners.codex ?? {}));
    for (const [id, cfg] of Object.entries(config.runners)) {
        if (registry.has(id))
            continue;
        registry.set(id, createCustomRunner(id, cfg));
    }
    return registry;
}
export function resolveRunner(registry, id) {
    const runner = registry.get(id);
    if (!runner) {
        throw new Error(`Unknown runner "${id}". Available: ${[...registry.keys()].join(", ")}`);
    }
    return runner;
}
