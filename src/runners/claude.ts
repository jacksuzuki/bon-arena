import { join } from "node:path"
import type { RunnerConfig } from "../config.ts"
import { commandExists } from "./available.ts"
import type { ArenaRunner, RunnerInput, RunnerInvocation } from "./types.ts"

/**
 * Claude Code CLI runner.
 *
 * Runs `claude -p` headlessly. Because nobody can answer permission prompts,
 * the runner passes --dangerously-skip-permissions. Isolation comes from the
 * dedicated git worktree, not from Claude's permission system.
 */
export function createClaudeRunner(config: RunnerConfig = {}): ArenaRunner {
  const command = config.command ?? "claude"
  return {
    id: "claude",
    label: config.label ?? "Claude",
    async isAvailable() {
      return commandExists(command)
    },
    invocation(input: RunnerInput): RunnerInvocation {
      const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text"]
      if (config.model) args.push("--model", config.model)
      args.push(...(config.extraArgs ?? []))
      return {
        command,
        args,
        promptViaStdin: true,
        env: {
          ...(config.env ?? {}),
          // Where Claude's own transcript for this run lands is up to Claude; we just tag the run.
          ARENA_RESULTS_DIR: join(input.resultsDir),
        },
      }
    },
  }
}
