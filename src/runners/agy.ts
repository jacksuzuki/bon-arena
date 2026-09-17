import { readFileSync } from "node:fs"
import type { RunnerConfig } from "../config.ts"
import { commandExists } from "./available.ts"
import type { ArenaRunner, AskInput, RunnerInput, RunnerInvocation, SessionLookup } from "./types.ts"

/**
 * `agy -p` gives up after 5 minutes unless told otherwise (Go duration syntax). Implementation runs
 * take much longer; the core's own timeouts and `arena stop` stay in charge of ending a run.
 */
export const AGY_RUN_PRINT_TIMEOUT = "12h"
export const AGY_ASK_PRINT_TIMEOUT = "1h"

/**
 * Antigravity CLI (`agy`) runner.
 *
 * Runs `agy -p` headlessly with --dangerously-skip-permissions. Two things differ from the other
 * built-ins: agy does not work in the process cwd (it uses its own scratch directory) unless the
 * worktree is passed with --add-dir, and it cannot read the prompt from stdin, so the prompt travels
 * as a single `-p=<prompt>` argument (`-p <prompt>` could mistake a following flag for the prompt).
 */
export function createAgyRunner(config: RunnerConfig = {}): ArenaRunner {
  const command = config.command ?? "agy"
  return {
    id: "agy",
    label: config.label ?? "Antigravity",
    async isAvailable() {
      return commandExists(command)
    },
    invocation(input: RunnerInput): RunnerInvocation {
      const args = ["--add-dir", input.cwd, "--dangerously-skip-permissions", "--print-timeout", AGY_RUN_PRINT_TIMEOUT]
      if (config.model) args.push("--model", config.model)
      args.push(...(config.extraArgs ?? []))
      // agy cannot pin a conversation id at launch; stream-json prints it in the very first event, so
      // it lands in the stdout log even when the run is stopped or times out (see findSessionId).
      args.push("--output-format", "stream-json")
      args.push(`-p=${input.prompt}`) // one argument, whatever the prompt contains
      return { command, args, promptViaStdin: false, env: config.env }
    },
    findSessionId(lookup: SessionLookup): string | null {
      return findAgyConversation(lookup.stdoutPath)
    },
    askInvocation(input: AskInput): RunnerInvocation {
      // agy has no read-only mode: even `--mode plan` and `--sandbox` can create files in print mode.
      // --sandbox is the only restriction on offer; beyond that the read-only rules in the prompt and
      // the core's worktree fingerprint check (which warns when an answer changed files) have to do.
      // --dangerously-skip-permissions stays on: print mode already runs as always-proceed, so it
      // grants nothing new, and without it a permission prompt nobody can answer would hang the ask.
      const args = [
        "--conversation",
        input.sessionId,
        "--add-dir",
        input.cwd,
        "--sandbox",
        "--dangerously-skip-permissions",
        "--print-timeout",
        AGY_ASK_PRINT_TIMEOUT,
        "--output-format",
        "text", // stdout is the answer
      ]
      if (config.model) args.push("--model", config.model)
      args.push(`-p=${input.prompt}`)
      return { command, args, promptViaStdin: false, env: config.env }
    },
  }
}

/**
 * Read the conversation id out of a stdout log written with `--output-format stream-json` (NDJSON:
 * `init`, `step_update`..., `result`) or `json` (a single result object). The log is opened in append
 * mode, so the last run's id wins. Never throws: a missing file, broken lines or no id give null.
 */
export function findAgyConversation(stdoutPath: string): string | null {
  let text: string
  try {
    text = readFileSync(stdoutPath, "utf8")
  } catch {
    return null
  }
  let conversation: string | null = null
  let fromStep: string | null = null
  for (const line of text.split("\n")) {
    if (!line.includes("conversation_id")) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue // truncated or interleaved output
    }
    if (!isObject(record)) continue
    const id = idOf(record) ?? idOf(record.result)
    if (id) {
      conversation = id
      fromStep = null
    } else {
      fromStep = idOf(record.step_update) ?? fromStep
    }
  }
  // A step id newer than the last init/result belongs to a later run whose init line was lost.
  return fromStep ?? conversation
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function idOf(value: unknown): string | null {
  if (!isObject(value)) return null
  const id = value.conversation_id
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null
}
