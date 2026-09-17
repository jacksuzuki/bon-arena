import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ArenaConfigSchema, loadConfig } from "../src/config.ts"
import { integrationStatuses, syncIntegrations } from "../src/integrations/index.ts"
import { createOrcaIntegration, insideOrca, orcaComment, orcaWorkspaceStatus } from "../src/integrations/orca.ts"
import { SessionSchema, type Session } from "../src/session.ts"

function session(overrides: Record<string, unknown> = {}): Session {
  const player = (id: string, label: string, status: string) => ({
    id,
    runner: id,
    label,
    branch: `arena/20260917-abc123/${id}`,
    worktree: `/arena/demo/20260917-abc123/${id}`,
    status,
    startedAt: "2026-09-17T00:00:00.000Z",
    finishedAt: status === "running" ? undefined : "2026-09-17T00:02:05.000Z",
    promptPath: "/p",
    stdoutPath: "/o",
    stderrPath: "/e",
    exitCodePath: "/x",
  })
  return SessionSchema.parse({
    id: "20260917-abc123",
    repository: "/repo/demo",
    projectName: "demo",
    baseBranch: "main",
    baseCommit: "0123456789abcdef",
    task: "do it",
    status: "running",
    players: [player("claude", "Claude", "completed"), player("codex", "Codex", "running")],
    verify: {},
    arenaDir: "/arena/demo/20260917-abc123",
    startedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  })
}

const ok = JSON.stringify({ ok: true, result: {} })

test("insideOrca reads the terminal environment", () => {
  assert.equal(insideOrca({ ORCA_WORKTREE_ID: "r::/p" }), true)
  assert.equal(insideOrca({ TERM_PROGRAM: "Orca" }), true)
  assert.equal(insideOrca({ TERM_PROGRAM: "iTerm.app" }), false)
})

test("orca status: auto follows the environment, booleans override, a missing CLI disables", () => {
  const make = (mode: "auto" | boolean, env: Record<string, string>, exists = true) =>
    createOrcaIntegration({ mode, env, exec: () => ok, commandExists: () => exists }).status()
  assert.equal(make("auto", { TERM_PROGRAM: "Orca" }).active, true)
  assert.equal(make("auto", {}).active, false)
  assert.equal(make(true, {}).active, true)
  assert.equal(make(false, { TERM_PROGRAM: "Orca" }).active, false)
  const missing = make(true, { TERM_PROGRAM: "Orca" }, false)
  assert.equal(missing.active, false)
  assert.equal(missing.available, false)
})

test("orca comment and board column follow the candidate's state", () => {
  const s = session()
  const [claude, codex] = s.players
  assert.equal(orcaWorkspaceStatus(s, codex!), "in-progress")
  assert.equal(orcaWorkspaceStatus(s, claude!), "in-review")
  assert.equal(orcaComment(s, claude!), "completed 2m05s")

  claude!.result = {
    runnerId: "claude",
    durationMs: 1,
    git: { changedFiles: 3, additions: 40, deletions: 5, commits: 0, diffPath: "/d", statusPath: "/s", files: [] },
    verification: { test: { command: "t", exitCode: 0, passed: true, durationMs: 1, logPath: "/l", timedOut: false }, lint: { command: "l", exitCode: 1, passed: false, durationMs: 1, logPath: "/l", timedOut: false } },
    collectedAt: "2026-09-17T00:03:00.000Z",
  }
  s.selected = "claude"
  assert.equal(orcaComment(s, claude!), "completed 2m05s · 3 files +40 −5 · test ✓ lint ✗ typecheck – · selected")

  s.adopted = { player: "claude", mode: "merge", commit: "fedcba9876543210", at: "2026-09-17T00:05:00.000Z" }
  assert.equal(orcaWorkspaceStatus(s, claude!), "completed")
  assert.match(orcaComment(s, claude!), /adopted \(merge\) → fedcba987654$/)
})

test("orca sync labels every candidate under the host worktree and falls back without a parent", () => {
  const calls: string[][] = []
  const orca = createOrcaIntegration({
    mode: true,
    env: {},
    commandExists: () => true,
    exec: (_cmd, args) => {
      calls.push(args)
      if (args.includes("--parent-worktree")) {
        const err = new Error("exit 1") as Error & { stdout: string }
        err.stdout = JSON.stringify({ ok: false, error: { code: "selector_not_found" } })
        throw err
      }
      return ok
    },
  })
  const entries = orca.sync(session())
  assert.deepEqual(entries, [{ player: "claude", ok: true }, { player: "codex", ok: true }])
  assert.equal(calls.length, 4)
  const first = calls[0]!
  assert.deepEqual(first.slice(0, 4), ["worktree", "set", "--worktree", "path:/arena/demo/20260917-abc123/claude"])
  assert.equal(first[first.indexOf("--display-name") + 1], "arena abc123 · Claude")
  assert.equal(first[first.indexOf("--parent-worktree") + 1], "path:/repo/demo")
  assert.equal(first.at(-1), "--json")
  assert.equal(calls[1]!.includes("--parent-worktree"), false)

  assert.deepEqual(orca.sync(session({ status: "cleaned" })), [])
})

test("orca sync reports failures per player and open shows changed files as diffs", () => {
  const calls: string[][] = []
  const failing = createOrcaIntegration({
    mode: true,
    env: {},
    commandExists: () => true,
    exec: () => JSON.stringify({ ok: false, error: { code: "runtime_unreachable" } }),
  })
  assert.deepEqual(failing.sync(session())[0], { player: "claude", ok: false, error: "runtime_unreachable" })

  const orca = createOrcaIntegration({ mode: true, env: {}, commandExists: () => true, exec: (_c, a) => (calls.push(a), ok) })
  const s = session()
  orca.open(s, s.players[1]!)
  assert.deepEqual(calls[0], ["file", "open-changed", "--mode", "diff", "--worktree", "path:/arena/demo/20260917-abc123/codex", "--json"])
})

test("syncIntegrations is best effort: inactive apps are skipped, failures are logged and retried", async () => {
  const config = ArenaConfigSchema.parse({})
  let calls = 0
  await syncIntegrations(session(), config, {}, { env: {}, commandExists: () => true, exec: () => (calls++, ok) })
  assert.equal(calls, 0) // auto + outside Orca

  const lines: string[] = []
  let attempts = 0
  await syncIntegrations(
    session(),
    config,
    { retries: 2, retryDelayMs: 1, log: (l) => lines.push(l) },
    {
      env: { TERM_PROGRAM: "Orca" },
      commandExists: () => true,
      exec: () => {
        attempts++
        throw new Error("boom")
      },
    },
  )
  assert.equal(attempts, 3 * 2 * 2) // 3 rounds × 2 players × (with parent, without parent)
  assert.match(lines.join("\n"), /warning: Orca integration: claude: boom; codex: boom/)
})

test("integrations config: defaults to auto and repository keys override user keys one by one", () => {
  const dir = mkdtempSync(join(tmpdir(), "arena-integrations-"))
  const prev = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = join(dir, "xdg")
  try {
    assert.equal(loadConfig(dir).integrations.orca, "auto")
    writeFileSync(join(dir, ".arena.yaml"), "integrations:\n  orca: false\n")
    assert.equal(loadConfig(dir).integrations.orca, false)
    const statuses = integrationStatuses(loadConfig(dir), { env: { TERM_PROGRAM: "Orca" }, commandExists: () => true })
    assert.deepEqual(statuses.map((s) => [s.id, s.active]), [["orca", false]])
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prev
    rmSync(dir, { recursive: true })
  }
})
