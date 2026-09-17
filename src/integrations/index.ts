import { execFileSync } from "node:child_process"
import type { ArenaConfig } from "../config.ts"
import { commandExists } from "../runners/available.ts"
import type { Session } from "../session.ts"
import { createOrcaIntegration } from "./orca.ts"
import type { Exec, IntegrationStatus, WorkspaceIntegration } from "./types.ts"

export type { IntegrationStatus, WorkspaceIntegration } from "./types.ts"

const defaultExec: Exec = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 })

export interface IntegrationDeps {
  exec?: Exec
  commandExists?: (command: string) => boolean
  env?: Record<string, string | undefined>
}

export function createIntegrations(config: ArenaConfig, deps: IntegrationDeps = {}): WorkspaceIntegration[] {
  return [
    createOrcaIntegration({
      mode: config.integrations.orca,
      exec: deps.exec ?? defaultExec,
      commandExists: deps.commandExists ?? commandExists,
      env: deps.env ?? process.env,
    }),
  ]
}

export function integrationStatuses(config: ArenaConfig, deps: IntegrationDeps = {}): IntegrationStatus[] {
  return createIntegrations(config, deps).map((i) => i.status())
}

export interface SyncOptions {
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
      let entries = integration.sync(session)
      for (let attempt = 0; attempt < (opts.retries ?? 0) && entries.some((e) => !e.ok); attempt++) {
        await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000))
        entries = integration.sync(session)
      }
      const failed = entries.filter((e) => !e.ok)
      if (failed.length) log(`warning: ${integration.label} integration: ${failed.map((e) => `${e.player}: ${e.error}`).join("; ")}`)
    } catch (err) {
      log(`warning: ${integration.label} integration: ${(err as Error).message}`)
    }
  }
}
