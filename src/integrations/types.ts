import type { Player, Session } from "../session.ts"

/** Run an external CLI and return its stdout. Throws when the command fails. Injected so tests never touch a real app. */
export type Exec = (command: string, args: string[]) => string

export interface IntegrationStatus {
  id: string
  label: string
  /** The app's CLI is installed. */
  available: boolean
  /** Arena will mirror sessions into the app (config `true`, or `auto` while running inside it). */
  active: boolean
  detail: string
}

export interface SyncEntry {
  player: string
  ok: boolean
  error?: string
}

/**
 * A workspace app (Orca, ...) that can show Arena's candidate worktrees.
 * Integrations are display-only: Arena Core keeps owning worktrees, runner processes and results,
 * and a failing integration must never fail an arena.
 */
export interface WorkspaceIntegration {
  id: string
  label: string
  status(): IntegrationStatus
  /** Mirror the session's current state into the app. Idempotent. */
  sync(session: Session): SyncEntry[]
  /** Once, right after the runners started: give every candidate a terminal that shows its live progress. */
  attach(session: Session): SyncEntry[]
  /** Bring a candidate's worktree and changed files up in the app. */
  open(session: Session, player: Player): void
}
