import { execFileSync } from "node:child_process"
import type { ArenaConfig } from "../config.ts"
import { commandExists } from "../runners/available.ts"
import type { Session } from "../session.ts"
import { createOrcaIntegration } from "./orca.ts"
import type { Exec, IntegrationStatus, WorkspaceIntegration } from "./types.ts"

export type { IntegrationStatus, WorkspaceIntegration } from "./types.ts"

const defaultExec: Exec = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 })

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Re-invoke this very CLI (works for the built dist, a checkout run with node, and global installs alike). */
function defaultFollowCommand(session: Session, player: { id: string }): string {
  const command = [process.execPath, process.argv[1] ?? "arena", "logs", session.id, player.id, "--follow"].map(shellQuote).join(" ")
  // The app's terminal is a fresh shell: carry a non-default state directory over.
  return process.env.ARENA_HOME ? `ARENA_HOME=${shellQuote(process.env.ARENA_HOME)} ${command}` : command
}

export interface IntegrationDeps {
  exec?: Exec
  commandExists?: (command: string) => boolean
  env?: Record<string, string | undefined>
  followCommand?: (session: Session, player: { id: string }) => string
}

export function createIntegrations(config: ArenaConfig, deps: IntegrationDeps = {}): WorkspaceIntegration[] {
  return [
    createOrcaIntegration({
      mode: config.integrations.orca,
      exec: deps.exec ?? defaultExec,
      commandExists: deps.commandExists ?? commandExists,
      env: deps.env ?? process.env,
      followCommand: deps.followCommand ?? defaultFollowCommand,
    }),
  ]
}

export function integrationStatuses(config: ArenaConfig, deps: IntegrationDeps = {}): IntegrationStatus[] {
  return createIntegrations(config, deps).map((i) => i.status())
}

/** Caveats of the active integrations for this repository, prefixed with the app's name. */
export function integrationNotes(config: ArenaConfig, repository: string, deps: IntegrationDeps = {}): string[] {
  return createIntegrations(config, deps)
    .filter((i) => i.status().active)
    .flatMap((i) => i.notes(repository).map((n) => `${i.label}: ${n}`))
}

export interface SyncOptions {
  /** What players are doing right now, by player id, when the session file cannot tell (review, ask). */
  activity?: Record<string, string>
  /** Also open a live-progress terminal per candidate (only right after `arena start`). */
  attach?: boolean
  /** Extra attempts for players the app does not know yet (it discovers new worktrees after a moment). */
  retries?: number
  retryDelayMs?: number
  log?: (line: string) => void
}

/** Mirror the session into every active integration. Best effort: problems are logged, never thrown. */
export async function syncIntegrations(session: Session, config: ArenaConfig, opts: SyncOptions = {}, deps: IntegrationDeps = {}): Promise<void> {
  const log = opts.log ?? (() => {})
  for (const integration of createIntegrations(config, deps)) {
    try {
      if (!integration.status().active) continue
      let entries = integration.sync(session, opts.activity)
      for (let attempt = 0; attempt < (opts.retries ?? 0) && entries.some((e) => !e.ok); attempt++) {
        await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000))
        entries = integration.sync(session, opts.activity)
      }
      if (opts.attach && entries.every((e) => e.ok)) {
        entries = integration.attach(session)
        for (const note of integration.notes(session.repository)) log(`note: ${integration.label}: ${note}`)
      }
      const failed = entries.filter((e) => !e.ok)
      if (failed.length) log(`warning: ${integration.label} integration: ${failed.map((e) => `${e.player}: ${e.error}`).join("; ")}`)
    } catch (err) {
      log(`warning: ${integration.label} integration: ${(err as Error).message}`)
    }
  }
}
