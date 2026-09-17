import { test } from "node:test"
import assert from "node:assert/strict"
import { formatDuration, renderSummary, renderStatus, renderCompareBundle } from "../src/compare/summary.ts"
import type { Session } from "../src/session.ts"

const session: Session = {
  id: "20260917-abc123",
  repository: "/repo",
  projectName: "repo",
  baseBranch: "main",
  baseCommit: "0123456789abcdef",
  task: "Do the thing\nwith details",
  status: "collected",
  arenaDir: "/arena/repo/20260917-abc123",
  startedAt: "2026-09-17T00:00:00.000Z",
  selected: "codex",
  verify: { test: "npm test", lint: "npm run lint" },
  setup: ["npm ci"],
  players: [
    {
      id: "claude",
      runner: "claude",
      label: "Claude",
      branch: "arena/20260917-abc123/claude",
      worktree: "/wt/claude",
      status: "completed",
      exitCode: 0,
      startedAt: "2026-09-17T00:00:00.000Z",
      finishedAt: "2026-09-17T00:06:31.000Z",
      promptPath: "/p",
      stdoutPath: "/o",
      stderrPath: "/e",
      exitCodePath: "/x",
      result: {
        runnerId: "claude",
        durationMs: 391000,
        git: { changedFiles: 8, additions: 312, deletions: 94, commits: 0, diffPath: "/nonexistent.diff", statusPath: "/s", files: [{ path: "a.ts", additions: 312, deletions: 94 }] },
        verification: {
          test: { command: "npm test", exitCode: 0, passed: true, durationMs: 1000, logPath: "/l", timedOut: false },
          lint: { command: "npm run lint", exitCode: 1, passed: false, durationMs: 1000, logPath: "/nonexistent.log", timedOut: false },
        },
        collectedAt: "2026-09-17T00:07:00.000Z",
      },
    },
    {
      id: "codex",
      runner: "codex",
      label: "Codex",
      branch: "arena/20260917-abc123/codex",
      worktree: "/wt/codex",
      status: "failed",
      exitCode: 2,
      startedAt: "2026-09-17T00:00:00.000Z",
      finishedAt: "2026-09-17T00:05:54.000Z",
      promptPath: "/p",
      stdoutPath: "/o",
      stderrPath: "/e",
      exitCodePath: "/x",
    },
  ],
}

test("formatDuration", () => {
  assert.equal(formatDuration(391000), "6m31s")
  assert.equal(formatDuration(3723000), "1h02m03s")
  assert.equal(formatDuration(undefined), "-")
})

test("renderSummary shows facts per candidate", () => {
  const out = renderSummary(session)
  assert.match(out, /Claude\n  status        completed\n  duration      6m31s\n  files         8\n  diff          \+312 \/ -94\n  tests         PASS\n  lint          FAIL \(exit 1\)\n  typecheck     n\/a/)
  assert.match(out, /Codex\n  status        failed \(exit 2\)/)
  assert.match(out, /results       not collected/)
  assert.match(out, /Selected: codex/)
})

test("renderStatus uses icons and clocks", () => {
  const out = renderStatus(session, Date.parse("2026-09-17T00:10:00.000Z"))
  assert.match(out, /Claude  ✓ completed 06:31/)
  assert.match(out, /Codex   ✗ failed    05:54  exit 2/)
})

test("renderCompareBundle includes task, criteria and per-candidate sections", () => {
  const out = renderCompareBundle(session)
  assert.match(out, /## Original task\n\nDo the thing\nwith details/)
  assert.match(out, /## Candidate: Claude \(claude\)/)
  assert.match(out, /- lint: FAIL \(exit 1\)/)
  assert.match(out, /## Candidate: Codex \(codex\)\n\n(.*\n)*- results: not collected/)
})

import { renderSynthesisBrief } from "../src/compare/summary.ts"

test("renderSynthesisBrief names the base worktree and includes the other candidate", () => {
  const withSynthesis: Session = { ...session, synthesis: { base: "claude", startedAt: "2026-09-17T00:08:00.000Z", snapshotCommit: "abcdef123456789" } }
  const out = renderSynthesisBrief(withSynthesis, session.players[0]!, [session.players[1]!])
  assert.match(out, /Base candidate: Claude \(claude\)/)
  assert.match(out, /Work in:\s+\/wt\/claude/)
  assert.match(out, /snapshot abcdef123456/)
  assert.match(out, /arena collect 20260917-abc123 --player claude/)
  assert.match(out, /## Other candidate: Codex \(codex\)/)
  assert.match(out, /- results: not collected/)
  const summary = renderSummary({ ...withSynthesis, adopted: { player: "claude", mode: "merge", commit: "fedcba987654321", at: "x" } })
  assert.match(summary, /Synthesis: base claude \(in progress\)/)
  assert.match(summary, /Adopted: claude via merge → fedcba987654/)
})
