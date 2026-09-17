import { homedir } from "node:os"
import { join } from "node:path"

/** Root directory for all arena state. Override with ARENA_HOME. */
export function arenaHome(): string {
  return process.env.ARENA_HOME ?? join(homedir(), ".arena")
}

export function sessionsDir(): string {
  return join(arenaHome(), "sessions")
}

export function sessionFile(id: string): string {
  return join(sessionsDir(), `${id}.json`)
}

/** Original requests saved by `arena refine` while a host refines them into a specification. */
export function draftsDir(): string {
  return join(arenaHome(), "drafts")
}

/** Directory holding worktrees, logs and results for one arena. */
export function arenaDir(projectName: string, id: string): string {
  return join(arenaHome(), projectName, id)
}

export function userConfigFile(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  return join(xdg, "arena", "config.yaml")
}
