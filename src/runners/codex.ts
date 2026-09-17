import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { RunnerConfig } from "../config.ts"
import { commandExists } from "./available.ts"
import type { ArenaRunner, AskInput, RunnerInput, RunnerInvocation, SessionLookup } from "./types.ts"

/**
 * Codex CLI runner.
 *
 * Runs `codex exec` non-interactively with the workspace-write sandbox and no
 * approval prompts (the equivalent of --full-auto). The worktree is the workspace.
 */
export function createCodexRunner(config: RunnerConfig = {}): ArenaRunner {
  const command = config.command ?? "codex"
  return {
    id: "codex",
    label: config.label ?? "Codex",
    async isAvailable() {
      return commandExists(command)
    },
    invocation(input: RunnerInput): RunnerInvocation {
      const args = [
        "exec",
        "-C",
        input.cwd,
        "--sandbox",
        "workspace-write",
        "-c",
        "approval_policy=\"never\"",
        "--color",
        "never",
        "-o",
        join(input.resultsDir, "codex.last-message.md"),
      ]
      if (config.model) args.push("--model", config.model)
      args.push(...(config.extraArgs ?? []))
      args.push("-") // read the prompt from stdin
      return { command, args, promptViaStdin: true, env: config.env }
    },
    findSessionId(lookup: SessionLookup): string | null {
      // `codex exec` has no way to pin a thread id, but it records every thread under
      // $CODEX_HOME/sessions with the working directory it ran in.
      return findCodexThread(codexSessionsDir(config.env), lookup.cwd, Date.parse(lookup.startedAt))
    },
    askInvocation(input: AskInput): RunnerInvocation {
      // `codex exec resume` has no --sandbox / -C flags; the sandbox comes from config overrides and
      // the working directory from the process cwd (the core spawns it inside the worktree).
      const args = [
        "exec",
        "resume",
        "-c",
        "sandbox_mode=\"read-only\"",
        "-c",
        "approval_policy=\"never\"",
      ]
      if (config.model) args.push("--model", config.model)
      args.push(input.sessionId, "-") // the answer is the final message on stdout
      return { command, args, promptViaStdin: true, env: config.env }
    },
  }
}

export function codexSessionsDir(env: Record<string, string> | undefined = undefined): string {
  const home = env?.CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex")
  return join(home, "sessions")
}

/**
 * Find the newest Codex thread whose `session_meta` names `cwd` and that started at or after
 * `startedAtMs` (with a minute of slack for clock skew between the launch and Codex's own stamp).
 */
export function findCodexThread(sessionsDir: string, cwd: string, startedAtMs: number): string | null {
  if (!existsSync(sessionsDir)) return null
  const slackMs = 60_000
  let best: { id: string; at: number } | null = null
  for (const file of walkRollouts(sessionsDir)) {
    const meta = readSessionMeta(file)
    if (!meta || meta.cwd !== cwd) continue
    if (Number.isFinite(startedAtMs) && meta.at < startedAtMs - slackMs) continue
    if (!best || meta.at > best.at) best = { id: meta.id, at: meta.at }
  }
  return best?.id ?? null
}

function* walkRollouts(dir: string): Generator<string> {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    const path = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(path).isDirectory()
    } catch {
      continue
    }
    if (isDir) yield* walkRollouts(path)
    else if (name.startsWith("rollout-") && name.endsWith(".jsonl")) yield path
  }
}

/** Read only the first line (the `session_meta` record) of a rollout file; they can be large. */
function readSessionMeta(file: string): { id: string; cwd: string; at: number } | null {
  let fd: number | null = null
  try {
    fd = openSync(file, "r")
    const buf = Buffer.alloc(64 * 1024)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const firstLine = buf.toString("utf8", 0, n).split("\n")[0] ?? ""
    const record = JSON.parse(firstLine) as { type?: string; timestamp?: string; payload?: { id?: string; session_id?: string; cwd?: string; timestamp?: string } }
    if (record.type !== "session_meta" || !record.payload) return null
    const id = record.payload.id ?? record.payload.session_id
    const cwd = record.payload.cwd
    if (!id || !cwd) return null
    const at = Date.parse(record.payload.timestamp ?? record.timestamp ?? "")
    return { id, cwd, at: Number.isFinite(at) ? at : 0 }
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
