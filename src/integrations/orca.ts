import { realpathSync } from "node:fs"
import type { Player, Session } from "../session.ts"
import { formatDuration, playerDurationMs } from "../compare/summary.ts"
import type { Exec, IntegrationStatus, SyncEntry, WorkspaceIntegration } from "./types.ts"

export type IntegrationMode = "auto" | boolean

export interface OrcaOptions {
  mode: IntegrationMode
  exec: Exec
  commandExists: (command: string) => boolean
  env: Record<string, string | undefined>
  command?: string
  /** Shell command that streams a player's progress (`arena logs <id> <player> --follow`). */
  followCommand: (session: Session, player: Player) => string
}

/** True inside a terminal that Orca manages. */
export function insideOrca(env: Record<string, string | undefined>): boolean {
  return Boolean(env.ORCA_WORKTREE_ID) || env.TERM_PROGRAM === "Orca"
}

/** Orca lists worktrees by their resolved path (e.g. /private/tmp, not /tmp). */
function selector(path: string): string {
  try {
    return `path:${realpathSync(path)}`
  } catch {
    return `path:${path}`
  }
}

const mark = (passed: boolean | undefined): string => (passed === undefined ? "–" : passed ? "✓" : "✗")

/** Board column for a candidate: running → in-progress, finished → in-review, merged → completed. */
export function orcaWorkspaceStatus(session: Session, player: Player): "in-progress" | "in-review" | "completed" {
  if (session.adopted?.player === player.id) return "completed"
  return player.status === "pending" || player.status === "running" ? "in-progress" : "in-review"
}

/** One-line state of a candidate, shown as the worktree comment in Orca's sidebar. */
export function orcaComment(session: Session, player: Player, now = Date.now(), activity?: string): string {
  // What is happening now goes first: the sidebar truncates long comments.
  const parts = [...(activity ? [`⏳ ${activity}`] : []), `${player.status} ${formatDuration(playerDurationMs(player, now))}`]
  const r = player.result
  if (r) {
    parts.push(`${r.git.changedFiles} files +${r.git.additions} −${r.git.deletions}`)
    const v = r.verification
    if (v.test || v.lint || v.typecheck) parts.push(`test ${mark(v.test?.passed)} lint ${mark(v.lint?.passed)} typecheck ${mark(v.typecheck?.passed)}`)
  }
  if (session.adopted?.player === player.id) parts.push(`adopted (${session.adopted.mode}) → ${session.adopted.commit.slice(0, 12)}`)
  else if (session.synthesis?.base === player.id) parts.push(session.synthesis.finishedAt ? "synthesis finished" : "synthesis base")
  else if (session.selected === player.id) parts.push("selected")
  const round = session.reviews.at(-1)
  const review = round?.entries.find((e) => e.player === player.id)
  if (round && review) parts.push(`review #${round.n}: ${review.error ? "failed" : review.timedOut ? "timed out" : review.verdict}`)
  return parts.join(" · ")
}

/**
 * Orca discovers git worktrees of a registered repo on its own, so Arena's candidates already show up
 * in its sidebar. This integration only labels them: name, status comment, board column, and the
 * worktree the arena was started from as parent. Runners stay headless under Arena Core.
 */
export function createOrcaIntegration(opts: OrcaOptions): WorkspaceIntegration {
  const command = opts.command ?? "orca"

  function run(args: string[]): void {
    let out: string
    try {
      out = opts.exec(command, [...args, "--json"])
    } catch (err) {
      const e = err as { stdout?: string | Buffer; message: string }
      out = e.stdout ? String(e.stdout) : ""
      if (!out.trim()) throw new Error(e.message)
    }
    let parsed: { ok?: boolean; error?: { code?: string; message?: string } }
    try {
      parsed = JSON.parse(out)
    } catch {
      throw new Error(`unexpected output from ${command} ${args.slice(0, 2).join(" ")}`)
    }
    if (!parsed.ok) throw new Error(parsed.error?.code ?? parsed.error?.message ?? "orca command failed")
  }

  function status(): IntegrationStatus {
    const available = opts.commandExists(command)
    const inside = insideOrca(opts.env)
    const base = { id: "orca", label: "Orca", available }
    if (opts.mode === false) return { ...base, active: false, detail: "disabled (integrations.orca: false)" }
    if (!available) return { ...base, active: false, detail: `${command} CLI not found in PATH` }
    if (opts.mode === true) return { ...base, active: true, detail: "enabled (integrations.orca: true)" }
    return inside
      ? { ...base, active: true, detail: "running inside Orca; candidate worktrees are labelled in its sidebar" }
      : { ...base, active: false, detail: "not running inside Orca (set integrations.orca: true to label worktrees anyway)" }
  }

  function sync(session: Session, activity: Record<string, string> = {}): SyncEntry[] {
    if (session.status === "cleaned") return [] // worktrees are gone; Orca drops them by itself
    const short = session.id.split("-").pop() ?? session.id
    return session.players.map((player) => {
      const args = [
        "worktree",
        "set",
        "--worktree",
        selector(player.worktree),
        "--display-name",
        `arena ${short} · ${player.label}`,
        "--comment",
        orcaComment(session, player, Date.now(), activity[player.id]),
        "--workspace-status",
        orcaWorkspaceStatus(session, player),
      ]
      try {
        try {
          run([...args, "--parent-worktree", selector(session.repository)])
        } catch {
          // The repository itself may not be a worktree Orca knows (or lineage is refused): label without a parent.
          run(args)
        }
        return { player: player.id, ok: true }
      } catch (err) {
        return { player: player.id, ok: false, error: (err as Error).message }
      }
    })
  }

  // Runners are headless processes owned by Arena, so a candidate's Orca terminal would be an empty
  // shell. Open one that follows the runner's log instead.
  function attach(session: Session): SyncEntry[] {
    return session.players.map((player) => {
      try {
        run(["terminal", "create", "--worktree", selector(player.worktree), "--title", `${player.label} (live)`, "--command", opts.followCommand(session, player)])
        return { player: player.id, ok: true }
      } catch (err) {
        return { player: player.id, ok: false, error: (err as Error).message }
      }
    })
  }

  function open(_session: Session, player: Player): void {
    run(["file", "open-changed", "--mode", "diff", "--worktree", selector(player.worktree)])
  }

  return { id: "orca", label: "Orca", status, sync, attach, open }
}
