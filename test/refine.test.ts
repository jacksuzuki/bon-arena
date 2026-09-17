import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildRefineContext, defaultTaskMode, REFINED_TASK_TEMPLATE, renderRefineBrief, repositoryLayout, saveTaskDraft, type RefineContext } from "../src/refine.ts"
import { SessionSchema } from "../src/session.ts"
import { loadConfig } from "../src/config.ts"

function tmp(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function gitRepo(t: TestContext, files: Record<string, string>): string {
  const dir = tmp(t, "arena-refine-repo-")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "arena@test")
  git("config", "user.name", "arena")
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    execFileSync("mkdir", ["-p", join(path, "..")])
    writeFileSync(path, content)
  }
  git("add", "-A")
  git("commit", "-qm", "init")
  return dir
}

function withArenaHome(t: TestContext): string {
  const home = tmp(t, "arena-refine-home-")
  const previous = process.env.ARENA_HOME
  process.env.ARENA_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.ARENA_HOME
    else process.env.ARENA_HOME = previous
  })
  return home
}

const context: RefineContext = {
  task: "Add password reset to the login screen",
  draftPath: "/home/.arena/drafts/20260917-abc123.original.md",
  repository: { root: "/repo", projectName: "repo", headCommit: "0123456789abcdef", branch: "main", dirty: true },
  repositoryError: null,
  verify: { test: "npm test" },
  setup: ["npm ci"],
  layout: ["src/", "package.json"],
  defaultMode: "refined",
}

test("renderRefineBrief contains the request, repository facts, procedure, launch command and template", () => {
  const out = renderRefineBrief(context)
  assert.match(out, /## Original request\n\nAdd password reset to the login screen\n/)
  assert.match(out, /- branch: main @ 0123456789ab \(uncommitted changes/)
  assert.match(out, /- test: `npm test`/)
  assert.match(out, /- lint: \(none detected\)/)
  assert.match(out, /- setup: `npm ci`/)
  assert.match(out, /- top level: src\/  package\.json/)
  assert.match(out, /- original request saved to: \/home\/\.arena\/drafts\/20260917-abc123\.original\.md/)
  assert.match(out, /## Procedure\n\n1\. Understand/)
  assert.match(out, /Ask the user only what remains/)
  assert.match(out, /Until the user confirms the specification, do not create worktrees, run setup, launch runners/)
  assert.match(out, /git show HEAD:<path>/)
  assert.match(out, /leave how open so the runners can take different approaches/)
  assert.match(out, /or cancel/)
  assert.match(out, /--original-task-file \/home\/\.arena\/drafts\/20260917-abc123\.original\.md --json <<'ARENA_TASK'/)
  assert.match(out, /Simple mode instead/)
  assert.ok(out.includes(REFINED_TASK_TEMPLATE.trimEnd()))
  for (const heading of ["## Goal", "## Scope", "## Requirements", "## Acceptance criteria", "## Constraints", "## Verification", "## Decisions"]) {
    assert.ok(REFINED_TASK_TEMPLATE.includes(heading), heading)
  }
})

test("renderRefineBrief degrades outside a git repository and without a draft", () => {
  const out = renderRefineBrief({ ...context, repository: null, repositoryError: "Not a git repository: /x", draftPath: null, layout: [], setup: [], verify: {}, defaultMode: "simple" })
  assert.match(out, /- Not a git repository: \/x/)
  assert.match(out, /- default mode: simple \(config `refine: false`\)/)
  assert.doesNotMatch(out, /saved to/)
  assert.match(out, /--original-task-file <original\.md> --json/)
})

test("buildRefineContext inspects the repository, detects commands and saves the draft", (t) => {
  const home = withArenaHome(t)
  const repo = gitRepo(t, {
    "package.json": JSON.stringify({ scripts: { test: "vitest" } }),
    "package-lock.json": "{}",
    "src/index.ts": "export {}",
  })
  const ctx = buildRefineContext({ repo, task: "  Do the thing  \n" })
  assert.equal(ctx.task, "Do the thing")
  assert.equal(ctx.repository?.branch, "main")
  assert.deepEqual(ctx.verify, { test: "npm test" })
  assert.deepEqual(ctx.setup, ["npm ci"])
  assert.deepEqual(ctx.layout, ["package-lock.json", "package.json", "src/"])
  assert.equal(ctx.defaultMode, "refined")
  assert.ok(ctx.draftPath?.startsWith(join(home, "drafts")))
  assert.equal(readFileSync(ctx.draftPath!, "utf8"), "Do the thing\n")
  assert.equal(buildRefineContext({ repo, task: "x", saveDraft: false }).draftPath, null)
  assert.throws(() => buildRefineContext({ repo, task: "  " }), /Task must not be empty/)
})

test("refine: false in .arena.yaml selects simple mode by default", (t) => {
  withArenaHome(t)
  const repo = gitRepo(t, { "a.txt": "a", ".arena.yaml": "refine: false\n" })
  assert.equal(loadConfig(repo).refine, false)
  assert.equal(defaultTaskMode(repo), "simple")
  assert.equal(buildRefineContext({ repo, task: "x", saveDraft: false }).defaultMode, "simple")
  const plain = gitRepo(t, { "a.txt": "a" })
  assert.equal(defaultTaskMode(plain), "refined")
})

test("repositoryLayout marks directories and truncates", (t) => {
  const repo = gitRepo(t, { "a.txt": "a", "b.txt": "b", "dir/c.txt": "c" })
  assert.deepEqual(repositoryLayout(repo), ["a.txt", "b.txt", "dir/"])
  assert.deepEqual(repositoryLayout(repo, 2), ["a.txt", "b.txt", "… (1 more)"])
  assert.deepEqual(repositoryLayout(tmp(t, "arena-not-a-repo-")), [])
})

test("saveTaskDraft writes under ARENA_HOME/drafts", (t) => {
  const home = withArenaHome(t)
  const path = saveTaskDraft("Hello\n", "20260917-abc123")
  assert.equal(path, join(home, "drafts", "20260917-abc123.original.md"))
  assert.ok(existsSync(path))
  assert.equal(readFileSync(path, "utf8"), "Hello\n")
})

test("session schema: sessions written before task modes existed parse as simple mode", () => {
  const legacy = {
    id: "20260917-abc123",
    repository: "/repo",
    projectName: "repo",
    baseBranch: "main",
    baseCommit: "0123456789abcdef",
    task: "Do the thing",
    status: "collected",
    players: [],
    verify: {},
    arenaDir: "/arena/repo/20260917-abc123",
    startedAt: "2026-09-17T00:00:00.000Z",
  }
  const session = SessionSchema.parse(legacy)
  assert.equal(session.taskMode, "simple")
  assert.equal(session.originalTask, undefined)
  const refined = SessionSchema.parse({ ...legacy, taskMode: "refined", originalTask: "do it" })
  assert.equal(refined.taskMode, "refined")
  assert.equal(refined.originalTask, "do it")
})
