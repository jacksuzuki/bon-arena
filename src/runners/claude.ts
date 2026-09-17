import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { RunnerConfig } from "../config.ts"
import { commandExists } from "./available.ts"
import type { ArenaRunner, AskInput, RunnerInput, RunnerInvocation } from "./types.ts"

/** Tools a resumed Claude conversation may use while answering a question: read-only inspection only. */
export const CLAUDE_ASK_ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
  "Bash(git blame:*)",
  "Bash(cat:*)",
  "Bash(ls:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
]
export const CLAUDE_ASK_DISALLOWED_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"]

/**
 * Claude Code CLI runner.
 *
 * Runs `claude -p` headlessly. Because nobody can answer permission prompts,
 * the runner passes --dangerously-skip-permissions. Isolation comes from the
 * dedicated git worktree, not from Claude's permission system.
 */
export function createClaudeRunner(config: RunnerConfig = {}): ArenaRunner {
  const command = config.command ?? "claude"
  // Auto-memory is keyed by repository, so a runner inside a worktree would read and write the
  // host project's memory. Disable it (setting + env, both honoured by Claude Code).
  const memoryOff = ["--settings", JSON.stringify({ autoMemoryEnabled: false })]
  const env = (resultsDir: string): Record<string, string> => ({
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...(config.env ?? {}),
    // Where Claude's own transcript for this run lands is up to Claude; we just tag the run.
    ARENA_RESULTS_DIR: join(resultsDir),
  })
  return {
    id: "claude",
    label: config.label ?? "Claude",
    async isAvailable() {
      return commandExists(command)
    },
    invocation(input: RunnerInput): RunnerInvocation {
      // Fix the conversation id up front so the finished conversation can be resumed for `arena ask`.
      const sessionId = randomUUID()
      const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text", "--session-id", sessionId, ...memoryOff]
      if (config.model) args.push("--model", config.model)
      args.push(...(config.extraArgs ?? []))
      return { command, args, promptViaStdin: true, env: env(input.resultsDir), sessionId }
    },
    askInvocation(input: AskInput): RunnerInvocation {
      // Resume the implementation conversation, but only with inspection tools: `dontAsk` denies
      // anything outside the allow list instead of prompting, and edits are denied outright.
      const args = [
        "-p",
        "--resume",
        input.sessionId,
        "--output-format",
        "text",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        CLAUDE_ASK_ALLOWED_TOOLS.join(","),
        "--disallowedTools",
        CLAUDE_ASK_DISALLOWED_TOOLS.join(","),
        ...memoryOff,
      ]
      if (config.model) args.push("--model", config.model)
      return { command, args, promptViaStdin: true, env: env(input.resultsDir) }
    },
  }
}
