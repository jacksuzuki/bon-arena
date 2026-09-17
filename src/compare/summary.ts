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
  const lines = [`Arena ${session.id} complete`, "", `Task: ${firstLine(session.task)}`]
  if (session.taskMode === "refined") lines.push(`Mode: refined specification${session.originalTask ? ` (original request: ${firstLine(session.originalTask)})` : ""}`)
  lines.push(`Base: ${session.baseCommit.slice(0, 12)}${session.baseBranch ? ` (${session.baseBranch})` : ""}`)
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
    if (p.asks.length) lines.push(`  questions     ${p.asks.length} answered (arena ask)${p.asks.some((a) => a.worktreeChanged) ? "  ⚠ worktree changed since collect" : ""}`)
    lines.push(`  branch        ${p.branch}`)
    lines.push(`  worktree      ${p.worktree}`)
    lines.push("")
  }
  if (session.selected) lines.push(`Selected: ${session.selected}`)
  if (session.synthesis) lines.push(`Synthesis: base ${session.synthesis.base}${session.synthesis.finishedAt ? ` (finished${session.synthesis.commit ? ` @ ${session.synthesis.commit.slice(0, 12)}` : ""})` : " (in progress)"}`)
  if (session.adopted) lines.push(`Adopted: ${session.adopted.player} via ${session.adopted.mode} → ${session.adopted.commit.slice(0, 12)}`)
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
  pushTaskSections(out, session)
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
    pushAskSections(out, p)
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

/**
 * Brief for the host performing the finishing pass: where to work, what the other candidates did,
 * and how to close out. Printed by `arena synthesize`.
 */
export function renderSynthesisBrief(session: Session, base: Player, others: Player[], opts: CompareBundleOptions = {}): string {
  const maxDiffBytes = opts.maxDiffBytes ?? 200_000
  const out: string[] = []
  out.push(`# Arena ${session.id} — synthesis brief`, "")
  out.push(`Base candidate: ${base.label} (${base.id})`)
  out.push(`Work in:        ${base.worktree}`)
  out.push(`Branch:         ${base.branch}${session.synthesis?.snapshotCommit ? ` (snapshot ${session.synthesis.snapshotCommit.slice(0, 12)})` : ""}`)
  out.push(`Base commit:    ${session.baseCommit}`)
  out.push("")
  pushTaskSections(out, session)
  out.push("## Procedure", "")
  out.push(`1. Edit only inside ${base.worktree}. Keep the base candidate's structure; fold in the strengths of the other candidate(s) listed below.`)
  out.push(`2. Re-verify: arena collect ${session.id} --player ${base.id}`)
  out.push(`3. Commit:    arena commit ${session.id} ${base.id} -m "arena(${session.id}): synthesis"`)
  out.push(`4. Finish:    arena finish ${session.id}`)
  out.push(`5. Merge only with the user's consent: arena adopt ${session.id}`)
  out.push("")
  for (const p of others) {
    out.push(`## Other candidate: ${p.label} (${p.id})`, "")
    out.push(`- worktree: ${p.worktree}`)
    out.push(`- branch: ${p.branch}`)
    out.push(`- status: ${p.status}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ""}`)
    const r = p.result
    if (!r) {
      out.push("- results: not collected", "")
      continue
    }
    out.push(`- changed files: ${r.git.changedFiles} (+${r.git.additions} / -${r.git.deletions})`)
    for (const kind of ["test", "lint", "typecheck"] as const) {
      if (session.verify[kind]) out.push(`- ${kind}: ${verdict(r.verification[kind])}`)
    }
    out.push("")
    if (r.git.files.length) {
      out.push("### Files", "")
      for (const f of r.git.files) out.push(`- ${f.path} (+${f.additions} / -${f.deletions})`)
      out.push("")
    }
    out.push("### Diff", "")
    const diff = existsSync(r.git.diffPath) ? readFileSync(r.git.diffPath, "utf8") : ""
    if (!diff.trim()) out.push("_(no changes)_", "")
    else if (diff.length > maxDiffBytes) out.push("```diff", diff.slice(0, maxDiffBytes), "```", "", `_(truncated; full diff: ${r.git.diffPath})_`, "")
    else out.push("```diff", diff, "```", "")
  }
  return out.join("\n")
}

/**
 * Task sections shared by the compare bundle and the synthesis brief. In refined mode the runners
 * saw only the specification; the original request is shown so reviewers can judge whether the
 * refinement (and the candidates) still serve what the user asked for.
 */
function pushTaskSections(out: string[], session: Session): void {
  if (session.taskMode === "refined") {
    out.push("## Task (refined specification, as given to the runners)", "", session.task.trim(), "")
    if (session.originalTask) out.push("## Original request (before refinement; not shown to the runners)", "", session.originalTask.trim(), "")
  } else {
    out.push("## Original task", "", session.task.trim(), "")
  }
}

/** Follow-up questions answered by the runner (`arena ask`), so reviewers see the runner's own account. */
function pushAskSections(out: string[], p: Player, maxAnswerChars = 12_000): void {
  if (!p.asks.length) return
  out.push(`### Questions answered by ${p.label} (arena ask)`, "")
  for (const a of p.asks) {
    out.push(`**Q${a.n}.** ${a.question.trim()}`, "")
    const answer = existsSync(a.answerPath) ? readFileSync(a.answerPath, "utf8").trim() : ""
    const status = a.timedOut ? " _(timed out)_" : a.exitCode !== 0 ? ` _(runner exited with ${a.exitCode ?? "signal"})_` : ""
    out.push(`**A${a.n}.**${status}${a.worktreeChanged ? " _(warning: the worktree changed while answering)_" : ""}`, "")
    if (!answer) out.push("_(no answer)_", "")
    else if (answer.length > maxAnswerChars) out.push(answer.slice(0, maxAnswerChars), "", `_(answer truncated; full text: ${a.answerPath})_`, "")
    else out.push(answer, "")
  }
}

function tail(s: string, maxChars: number): string {
  return s.length > maxChars ? `...\n${s.slice(-maxChars)}` : s
}
