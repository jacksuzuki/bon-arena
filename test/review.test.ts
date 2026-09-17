import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitCandidate, cleanArena, parseReviewVerdict, reviewFinal, selectCandidate, startArena, startSynthesis, waitForArena } from "../src/core.ts"
import { loadSession } from "../src/session.ts"
import { describeReviewRound, renderReviewReport, renderSummary } from "../src/compare/summary.ts"

/**
 * End-to-end: two mock runners "implement" a task; the host synthesizes on one of them; then
 * `reviewFinal` resumes both conversations with the final diff. The mock's review mode answers
 * with the verdict given in its askArgs and echoes what it was told about the final version.
 */
const MOCK = `
const mode = process.argv[2]
const fs = require("node:fs")
if (mode === "run") {
  fs.writeFileSync("impl.txt", "implemented by " + process.env.ARENA_PLAYER + "\\n")
  process.stdout.write("done\\n")
} else {
  const prompt = fs.readFileSync(0, "utf8")
  const verdict = process.argv[4] ?? "approve"
  if (verdict === "hang") { setTimeout(() => {}, 60_000); return }
  const worktreeLine = (prompt.match(/^- worktree: (.*)$/m) ?? [])[1]
  const origin = (prompt.match(/^- It is (.*?)[:.]/m) ?? [])[1]
  const hasDiff = prompt.includes("+host touch")
  process.stdout.write("VERDICT: " + verdict + "\\n- [minor] impl.txt:1 — reviewed by " + process.argv[3] + "\\nfinal=" + worktreeLine + "\\norigin=" + origin + "\\ndiff=" + hasDiff + "\\n")
}
`

function fixture(t: TestContext, runners: string): { repo: string; cleanup: (fn: () => void) => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arena-review-")))
  const cleanups: Array<() => void> = []
  const previous = process.env.ARENA_HOME
  t.after(() => {
    for (const fn of cleanups.reverse()) {
      try {
        fn()
      } catch {
        /* best effort */
      }
    }
    if (previous === undefined) delete process.env.ARENA_HOME
    else process.env.ARENA_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  })
  const repo = join(dir, "repo")
  const mock = join(dir, "mock.cjs")
  writeFileSync(mock, MOCK)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  writeFileSync(join(repo, "README.md"), "hello\n")
  const yaml = runners
    .replace(/\{\{node\}\}/g, JSON.stringify(process.execPath))
    .replace(/\{\{mock\}\}/g, JSON.stringify(mock))
  writeFileSync(join(repo, ".arena.yaml"), `${yaml}verify: { test: false, lint: false, typecheck: false }\nsetup: false\n`)
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"])
  process.env.ARENA_HOME = join(dir, "home")
  return { repo, cleanup: (fn) => cleanups.push(fn) }
}

const TWO_RUNNERS = `runners:
  alpha:
    command: {{node}}
    args: [{{mock}}, run]
    askArgs: [{{mock}}, ask, alpha, approve]
  beta:
    command: {{node}}
    args: [{{mock}}, run]
    askArgs: [{{mock}}, ask, beta, request-changes]
`

test("parseReviewVerdict reads the first VERDICT line leniently", () => {
  assert.equal(parseReviewVerdict("VERDICT: approve\n- nit"), "approve")
  assert.equal(parseReviewVerdict("**VERDICT:** request-changes"), "request-changes")
  assert.equal(parseReviewVerdict("verdict: Request Changes\n"), "request-changes")
  assert.equal(parseReviewVerdict("Looks fine.\nVERDICT: approve"), "approve")
  assert.equal(parseReviewVerdict("I approve of this."), "unknown")
  assert.equal(parseReviewVerdict(""), "unknown")
})

test("reviewFinal has every runner review the synthesized final version in parallel and records the round", async (t) => {
  const { repo, cleanup } = fixture(t, TWO_RUNNERS)
  const session = await startArena({ repo, task: "write impl", players: ["alpha", "beta"] })
  cleanup(() => cleanArena(session.id, { force: true }))
  await waitForArena(session.id, { intervalMs: 100, timeoutMs: 30_000 })

  await assert.rejects(reviewFinal(session.id), /No candidate selected/)

  // Host finishes on alpha: synthesis snapshot, then an edit that stays uncommitted (the review must see it).
  const { base } = startSynthesis(session.id, "alpha")
  writeFileSync(join(base.worktree, "impl.txt"), "implemented by alpha\nhost touch\n")

  const r = await reviewFinal(session.id, { instructions: "Focus on impl.txt." })
  assert.equal(r.round.n, 1)
  assert.equal(r.round.target, "alpha")
  assert.equal(r.round.instructions, "Focus on impl.txt.")
  assert.match(readFileSync(r.round.diffPath, "utf8"), /\+host touch/)
  assert.deepEqual(
    r.round.entries.map((e) => [e.player, e.verdict, e.exitCode, e.timedOut, e.worktreeChanged]),
    [
      ["alpha", "approve", 0, false, false],
      ["beta", "request-changes", 0, false, false],
    ],
  )
  // Both reviewers were told where the final version is and how it relates to their own candidate.
  assert.match(r.answers.alpha!, new RegExp(`final=${base.worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\norigin=based on YOUR candidate\\ndiff=true`))
  assert.match(r.answers.beta!, new RegExp(`final=${base.worktree.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\norigin=based on the OTHER candidate\\ndiff=true`))
  const betaPrompt = readFileSync(r.round.entries[1]!.promptPath!, "utf8")
  assert.match(betaPrompt, /Additional instructions from the host:\nFocus on impl\.txt\./)
  assert.match(betaPrompt, /read-only exchange/)
  assert.ok(betaPrompt.includes(session.players[1]!.worktree), "the other reviewer is told its own worktree is not the final version")
  assert.equal(readFileSync(r.round.entries[1]!.answerPath!, "utf8"), r.answers.beta)
  // The reviewers' worktrees are untouched: beta still holds its own candidate.
  assert.equal(readFileSync(join(session.players[1]!.worktree, "impl.txt"), "utf8"), "implemented by beta\n")
  // Recorded in the session and visible in the summary.
  const stored = loadSession(session.id)
  assert.equal(stored.reviews.length, 1)
  assert.match(renderSummary(stored), /Review 1: alpha: approve, beta: request-changes \(target alpha @ [0-9a-f]{12}\)/)
  const report = renderReviewReport(stored, stored.reviews[0]!)
  assert.match(report, /^# Arena .* — review round 1\n/)
  assert.match(report, /Final version: alpha @ [0-9a-f]{12} \(synthesis\)/)
  assert.match(report, /## alpha — approve \(\d+m\d+s\)\n\nVERDICT: approve/)
  assert.match(report, /## beta — request-changes/)

  // A second round after the host committed its fix, limited to one reviewer.
  commitCandidate(session.id, "alpha", "synthesis")
  const again = await reviewFinal(session.id, { players: ["beta"] })
  assert.equal(again.round.n, 2)
  assert.deepEqual(again.round.entries.map((e) => e.player), ["beta"])
  assert.notEqual(again.round.targetCommit, r.round.targetCommit)
  assert.equal(loadSession(session.id).reviews.length, 2)
})

test("reviewFinal records runners that cannot be asked or time out instead of failing the round", async (t) => {
  const { repo, cleanup } = fixture(
    t,
    `runners:
  plain:
    command: {{node}}
    args: [{{mock}}, run]
  slow:
    command: {{node}}
    args: [{{mock}}, run]
    askArgs: [{{mock}}, ask, slow, hang]
`,
  )
  const session = await startArena({ repo, task: "noop", players: ["plain", "slow"] })
  cleanup(() => cleanArena(session.id, { force: true }))
  await waitForArena(session.id, { intervalMs: 100, timeoutMs: 30_000 })
  selectCandidate(session.id, "plain")

  const r = await reviewFinal(session.id, { timeoutMs: 1_500 })
  const [plain, slow] = r.round.entries
  assert.equal(plain!.verdict, "unknown")
  assert.match(plain!.error!, /cannot resume its conversation/)
  assert.equal(slow!.timedOut, true)
  assert.equal(slow!.verdict, "unknown")
  assert.equal(r.answers.slow, "")
  assert.equal(describeReviewRound(loadSession(session.id), r.round), `plain: not asked, slow: timed out (target plain @ ${r.round.targetCommit!.slice(0, 12)})`)
  assert.match(renderReviewReport(r.session, r.round), /## plain — not asked\n\nRunner "plain" cannot resume[\s\S]*## slow — unknown \(timed out after 0m0[12]s\)\n\n_\(no answer\)_/)
})
