import type { ArenaConfig } from "../config.ts"
import { createClaudeRunner } from "./claude.ts"
import { createCodexRunner } from "./codex.ts"
import { createCustomRunner } from "./custom.ts"
import type { ArenaRunner } from "./types.ts"

export const BUILTIN_RUNNER_IDS = ["claude", "codex"] as const

/** Build the runner registry: built-ins (optionally overridden by config) plus custom config runners. */
export function createRunnerRegistry(config: ArenaConfig): Map<string, ArenaRunner> {
  const registry = new Map<string, ArenaRunner>()
  registry.set("claude", createClaudeRunner(config.runners.claude ?? {}))
  registry.set("codex", createCodexRunner(config.runners.codex ?? {}))
  for (const [id, cfg] of Object.entries(config.runners)) {
    if (registry.has(id)) continue
    registry.set(id, createCustomRunner(id, cfg))
  }
  return registry
}

export function resolveRunner(registry: Map<string, ArenaRunner>, id: string): ArenaRunner {
  const runner = registry.get(id)
  if (!runner) {
    throw new Error(`Unknown runner "${id}". Available: ${[...registry.keys()].join(", ")}`)
  }
  return runner
}
