import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { askPlayer, cleanArena, startArena, waitForArena } from "../src/core.ts"
import { loadSession } from "../src/session.ts"

/**
 * End-to-end: a mock runner "implements" a task, then answers a question through `askPlayer`.
 * The mock's ask mode echoes the session id and the question; the `touch` variant also edits a file
 * so the worktree-change detection is exercised.
 */
const MOCK = `
const mode = process.argv[2]
const fs = require("node:fs")
if (mode === "run") {
  fs.writeFileSync("impl.txt", "implemented\\n")
  process.stdout.write("done\\n")
} else {
  const prompt = fs.readFileSync(0, "utf8")
  const question = prompt.split("QUESTION:\\n")[1] ?? ""
  if (process.argv[4] === "touch") fs.writeFileSync("impl.txt", "changed while answering\\n")
  process.stdout.write("ANSWER[" + process.argv[3] + "]: " + question.trim() + "\\n")
  process.stderr.write("mock resumed\\n")
}
`

function fixture(t: TestContext): { repo: string; home: string; cleanup: (fn: () => void) => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "arena-ask-")))
  const cleanups: Array<() => void> = []
  // One hook so arena cleanup runs while ARENA_HOME still points at the fixture.
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
  const home = join(dir, "home")
  const mock = join(dir, "mock.cjs")
  writeFileSync(mock, MOCK)
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  writeFileSync(join(repo, "README.md"), "hello\n")
  writeFileSync(
    join(repo, ".arena.yaml"),
    [
      "runners:",
      "  mock:",
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(mock)}, run]`,
      `    askArgs: [${JSON.stringify(mock)}, ask, "{{sessionId}}"]`,
      "  touchy:",
      `    command: ${JSON.stringify(process.execPath)}`,
      `    args: [${JSON.stringify(mock)}, run]`,
      `    askArgs: [${JSON.stringify(mock)}, ask, "{{sessionId}}", touch]`,
      "verify: { test: false, lint: false, typecheck: false }",
      "setup: false",
      "",
    ].join("\n"),
  )
  execFileSync("git", ["-C", repo, "add", "."])
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"])
  const previous = process.env.ARENA_HOME
  process.env.ARENA_HOME = home
  return { repo, home, cleanup: (fn) => cleanups.push(fn) }
}

test("askPlayer resumes a finished runner inside its worktree and records the answer", async (t) => {
  const { repo, cleanup } = fixture(t)
  const session = await startArena({ repo, task: "write impl", players: ["mock", "touchy"] })
  cleanup(() => cleanArena(session.id, { force: true }))
  await waitForArena(session.id, { intervalMs: 100, timeoutMs: 30_000 })

  await assert.rejects(askPlayer(session.id, "mock", "   "), /Question must not be empty/)

  const first = await askPlayer(session.id, "mock", "Why is impl.txt so short?\nSecond line.")
  assert.equal(first.ask.n, 1)
  assert.equal(first.ask.exitCode, 0)
  assert.equal(first.ask.timedOut, false)
  assert.equal(first.ask.worktreeChanged, false)
  assert.equal(first.answer, "ANSWER[]: Why is impl.txt so short?\nSecond line.\n")
  assert.equal(readFileSync(first.ask.answerPath, "utf8"), first.answer)
  assert.match(readFileSync(first.ask.promptPath, "utf8"), /read-only exchange[\s\S]*QUESTION:\nWhy is impl\.txt so short\?\nSecond line\.\n$/)
  assert.match(readFileSync(first.ask.stderrPath, "utf8"), /mock resumed/)
  assert.ok(first.ask.answerPath.startsWith(join(session.arenaDir, "results")))

  const second = await askPlayer(session.id, "mock", "Again?")
  assert.equal(second.ask.n, 2)
  const stored = loadSession(session.id)
  assert.deepEqual(stored.players[0]!.asks.map((a) => a.question), ["Why is impl.txt so short?\nSecond line.", "Again?"])
  assert.equal(readFileSync(join(stored.players[0]!.worktree, "impl.txt"), "utf8"), "implemented\n")

  assert.equal(execFileSync("git", ["-C", stored.players[0]!.worktree, "status", "--porcelain"], { encoding: "utf8" }), "?? impl.txt\n", "fingerprinting must not stage anything")
  assert.ok(!existsSync(join(session.arenaDir, "logs", "mock.ask.index")), "scratch index is removed")

  const touched = await askPlayer(session.id, "touchy", "Please do not edit anything.")
  assert.equal(touched.ask.worktreeChanged, true, "an answer that edited the worktree is flagged")
  assert.equal(readFileSync(join(stored.players[1]!.worktree, "impl.txt"), "utf8"), "changed while answering\n")
})

test("askPlayer refuses runners that cannot resume and players that are still running or cleaned", async (t) => {
  const { repo, cleanup } = fixture(t)
  writeFileSync(join(repo, ".arena.yaml"), `runners:\n  plain:\n    command: ${JSON.stringify(process.execPath)}\n    args: ["-e", "0"]\nverify: { test: false, lint: false, typecheck: false }\nsetup: false\n`)
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "plain runner"])
  const session = await startArena({ repo, task: "noop", players: ["plain"] })
  cleanup(() => cleanArena(session.id, { force: true }))
  await waitForArena(session.id, { intervalMs: 100, timeoutMs: 30_000 })
  await assert.rejects(askPlayer(session.id, "plain", "hi"), /cannot resume its conversation[\s\S]*askArgs/)
  cleanArena(session.id)
  assert.ok(!existsSync(session.players[0]!.worktree))
  await assert.rejects(askPlayer(session.id, "plain", "hi"), /Worktree missing/)
})
