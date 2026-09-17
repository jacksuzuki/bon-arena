import type { ArenaConfig } from "../config.ts"
import { createAgyRunner } from "./agy.ts"
import { createClaudeRunner } from "./claude.ts"
import { createCodexRunner } from "./codex.ts"
import { createCustomRunner } from "./custom.ts"
import type { ArenaRunner } from "./types.ts"

export const BUILTIN_RUNNER_IDS = ["claude", "codex", "agy"] as const

/**
 * Every built-in runner is launched without permission prompts or a sandbox: headless runs cannot
 * answer prompts, and all players must compete under the same conditions. Shown by `arena doctor`
 * and when a run starts.
 */
export const PERMISSIONS_NOTICE = [
  "Built-in runners run with FULL permissions: no approval prompts and no sandbox.",
  "They can read, change and run anything your user account can. The worktree is not a security boundary.",
  "For code or dependencies you do not trust, run Arena inside a container or VM.",
] as const

/** Build the runner registry: built-ins (optionally overridden by config) plus custom config runners. */
export function createRunnerRegistry(config: ArenaConfig): Map<string, ArenaRunner> {
  const registry = new Map<string, ArenaRunner>()
  registry.set("claude", createClaudeRunner(config.runners.claude ?? {}))
  registry.set("codex", createCodexRunner(config.runners.codex ?? {}))
  registry.set("agy", createAgyRunner(config.runners.agy ?? {}))
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
