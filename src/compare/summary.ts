import { readFileSync, existsSync } from "node:fs"
import type { Player, Session, VerificationResult } from "../session.ts"

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "-"
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m${String(s).padStart(2, "0")}s`
  return `${m}m${String(s).padStart(2, "0")}s`
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

export function playerDurationMs(p: Player, now = Date.now()): number | undefined {
  if (!p.startedAt) return undefined
  const start = Date.parse(p.startedAt)
  const end = p.finishedAt ? Date.parse(p.finishedAt) : now
  return end - start
}

export function verdict(v: VerificationResult | undefined): string {
  if (!v) return "n/a"
  if (v.timedOut) return "TIMEOUT"
  return v.passed ? "PASS" : `FAIL (exit ${v.exitCode ?? "?"})`
}

const STATUS_ICON: Record<Player["status"], string> = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
  stopped: "■",
}

export function renderStatus(session: Session, now = Date.now()): string {
  const width = Math.max(...session.players.map((p) => p.label.length), 6)
  const lines = [`Arena ${session.id}  [${session.status}]`, ""]
  for (const p of session.players) {
    const dur = playerDurationMs(p, now)
    const extra = p.status === "failed" && p.exitCode !== undefined ? `  exit ${p.exitCode}` : ""
    lines.push(`${p.label.padEnd(width)}  ${STATUS_ICON[p.status]} ${p.status.padEnd(9)} ${dur === undefined ? "--:--" : formatClock(dur)}${extra}`)
  }
  return lines.join("\n")
}

export function renderSummary(session: Session): string {
  const lines = [`Arena ${session.id} complete`, "", `Task: ${firstLine(session.task)}`, `Base: ${session.baseCommit.slice(0, 12)}${session.baseBranch ? ` (${session.baseBranch})` : ""}`]
  if (session.setup.length) lines.push(`Setup: ${session.setup.join(" && ")}`)
  lines.push("")
  for (const p of session.players) {
    lines.push(p.label)
    lines.push(`  status        ${p.status}${p.exitCode !== undefined && p.exitCode !== null && p.exitCode !== 0 ? ` (exit ${p.exitCode})` : ""}`)
    lines.push(`  duration      ${formatDuration(playerDurationMs(p))}`)
    const r = p.result
    if (r) {
      lines.push(`  files         ${r.git.changedFiles}`)
      lines.push(`  diff          +${r.git.additions} / -${r.git.deletions}`)
      if (r.git.commits > 0) lines.push(`  commits       ${r.git.commits}`)
      lines.push(`  tests         ${session.verify.test ? verdict(r.verification.test) : "n/a"}`)
      lines.push(`  lint          ${session.verify.lint ? verdict(r.verification.lint) : "n/a"}`)
      lines.push(`  typecheck     ${session.verify.typecheck ? verdict(r.verification.typecheck) : "n/a"}`)
    } else {
      lines.push(`  results       not collected (run: arena collect ${session.id})`)
    }
    lines.push(`  branch        ${p.branch}`)
    lines.push(`  worktree      ${p.worktree}`)
    lines.push("")
  }
  if (session.selected) lines.push(`Selected: ${session.selected}`)
  return lines.join("\n").trimEnd()
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? ""
  return line.length > 100 ? `${line.slice(0, 97)}...` : line
}

export interface CompareBundleOptions {
  /** Max bytes of each diff to inline. */
  maxDiffBytes?: number
  /** Include the tail of verification logs for failed checks. */
  includeFailureLogs?: boolean
}

/**
 * Markdown bundle handed to whichever LLM/harness performs the review.
 * The arena core never calls a model itself.
 */
export function renderCompareBundle(session: Session, opts: CompareBundleOptions = {}): string {
  const maxDiffBytes = opts.maxDiffBytes ?? 200_000
  const includeFailureLogs = opts.includeFailureLogs ?? true
  const out: string[] = []
  out.push(`# Arena ${session.id} — implementation comparison`, "")
  out.push(`Base commit: ${session.baseCommit}${session.baseBranch ? ` (${session.baseBranch})` : ""}`)
  out.push(`Repository: ${session.repository}`, "")
  out.push("## Original task", "", session.task.trim(), "")
  out.push("## Verification commands", "")
  for (const kind of ["test", "lint", "typecheck"] as const) {
    out.push(`- ${kind}: ${session.verify[kind] ? "`" + session.verify[kind] + "`" : "(none)"}`)
  }
  out.push("")
  out.push("## Review criteria", "", "- correctness", "- task completeness", "- regression risk", "- architecture fit", "- code complexity", "- adherence to existing conventions", "- test quality", "- unnecessary changes", "")

  for (const p of session.players) {
    out.push(`## Candidate: ${p.label} (${p.id})`, "")
    out.push(`- branch: ${p.branch}`)
    out.push(`- worktree: ${p.worktree}`)
    out.push(`- runner status: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""}`)
    out.push(`- duration: ${formatDuration(playerDurationMs(p))}`)
    const r = p.result
    if (!r) {
      out.push("- results: not collected", "")
      continue
    }
    out.push(`- changed files: ${r.git.changedFiles} (+${r.git.additions} / -${r.git.deletions})`)
    for (const kind of ["test", "lint", "typecheck"] as const) {
      if (!session.verify[kind]) continue
      out.push(`- ${kind}: ${verdict(r.verification[kind])}`)
    }
    out.push("")
    if (r.git.files.length > 0) {
      out.push("### Files", "")
      for (const f of r.git.files) out.push(`- ${f.path} (+${f.additions} / -${f.deletions})`)
      out.push("")
    }
    if (includeFailureLogs) {
      for (const kind of ["test", "lint", "typecheck"] as const) {
        const v = r.verification[kind]
        if (v && !v.passed && existsSync(v.logPath)) {
          out.push(`### ${kind} output (failed)`, "", "```", tail(readFileSync(v.logPath, "utf8"), 4000), "```", "")
        }
      }
    }
    out.push("### Diff", "")
    const diff = existsSync(r.git.diffPath) ? readFileSync(r.git.diffPath, "utf8") : ""
    if (!diff.trim()) {
      out.push("_(no changes)_", "")
    } else if (diff.length > maxDiffBytes) {
      out.push("```diff", diff.slice(0, maxDiffBytes), "```", "", `_(diff truncated at ${maxDiffBytes} bytes; full diff: ${r.git.diffPath})_`, "")
    } else {
      out.push("```diff", diff, "```", "")
    }
  }
  return out.join("\n")
}

function tail(s: string, maxChars: number): string {
  return s.length > maxChars ? `...\n${s.slice(-maxChars)}` : s
}
