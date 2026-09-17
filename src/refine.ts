/**
 * Task refinement support.
 *
 * Arena Core never calls a model. Refinement — understanding the user's request, asking about
 * unclear points and turning it into a specification that runners can implement in one shot — is
 * done by the host (e.g. the Claude Code /arena skill). This module gives every host the same
 * material: repository facts, a saved copy of the original request, the procedure to follow and
 * the specification template, so refined tasks look alike no matter which host produced them.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig } from "./config.ts"
import { gitTry, inspectRepository, type RepositoryInfo } from "./git/repository.ts"
import { draftsDir } from "./paths.ts"
import { newArenaId, type VerifyCommands } from "./session.ts"
import { resolveSetupCommands, resolveVerifyCommands } from "./verification/detect.ts"

export type TaskMode = "refined" | "simple"

export interface RefineContext {
  /** The user's request, verbatim (trimmed). */
  task: string
  /** Where the request was saved for `arena start --original-task-file`; null when not saved. */
  draftPath: string | null
  repository: RepositoryInfo | null
  repositoryError: string | null
  verify: VerifyCommands
  setup: string[]
  /** Top-level tracked entries of the repository (directories end with "/"). */
  layout: string[]
  /** Mode hosts should use when the user did not choose one (`refine` in .arena.yaml / config.yaml). */
  defaultMode: TaskMode
}

export interface RefineOptions {
  repo: string
  task: string
  /** Save the request under ~/.arena/drafts (default true). */
  saveDraft?: boolean
  maxLayoutEntries?: number
}

/** Default task mode for a repository: `refine: false` in config selects simple mode. */
export function defaultTaskMode(repoRoot: string): TaskMode {
  return loadConfig(repoRoot).refine === false ? "simple" : "refined"
}

/** Top-level tracked files and directories, so a host can orient itself without listing the repo. */
export function repositoryLayout(root: string, max = 40): string[] {
  const out = gitTry(root, ["ls-tree", "--name-only", "HEAD"])
  if (out.exitCode !== 0) return []
  const dirs = new Set(
    gitTry(root, ["ls-tree", "-d", "--name-only", "HEAD"])
      .stdout.split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  )
  const entries = out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((name) => (dirs.has(name) ? `${name}/` : name))
  return entries.length > max ? [...entries.slice(0, max), `… (${entries.length - max} more)`] : entries
}

/** Save the original request so `arena start --original-task-file <path>` can record it verbatim. */
export function saveTaskDraft(task: string, id = newArenaId()): string {
  const dir = draftsDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${id}.original.md`)
  writeFileSync(path, task.trim() + "\n")
  return path
}

export function buildRefineContext(opts: RefineOptions): RefineContext {
  const task = opts.task.trim()
  if (!task) throw new Error("Task must not be empty")
  let repository: RepositoryInfo | null = null
  let repositoryError: string | null = null
  try {
    repository = inspectRepository(opts.repo)
  } catch (err) {
    repositoryError = (err as Error).message
  }
  const root = repository?.root ?? opts.repo
  const config = loadConfig(root)
  return {
    task,
    draftPath: opts.saveDraft === false ? null : saveTaskDraft(task),
    repository,
    repositoryError,
    verify: repository ? resolveVerifyCommands(root, config.verify) : {},
    setup: repository ? resolveSetupCommands(root, config.setup, undefined) : [],
    layout: repository ? repositoryLayout(root, opts.maxLayoutEntries) : [],
    defaultMode: config.refine === false ? "simple" : "refined",
  }
}

/** Skeleton the host fills in. Every section is there so two runners read the same contract. */
export const REFINED_TASK_TEMPLATE = `# <title: one line, imperative>

## Goal
<what must be true when the task is done, in one or two sentences>

## Background
<what exists today and where: modules, entry points, tests, conventions the change touches>

## Scope
- In: <concrete changes, one per line>
- Out (non-goals): <things a runner might be tempted to do but must not>

## Requirements
1. <behavior, API, naming, data, error handling — concrete enough to test>
2. …

## Acceptance criteria
- [ ] <observable check; include the exact command when there is one>
- [ ] …

## Constraints
- <compatibility to preserve, files not to touch, style/conventions to follow, dependencies allowed>

## Verification
- <commands that must pass; new tests to add>

## Decisions
- <question that was open> → <decision> (<user / default>)
`

/** Markdown brief for the host performing the refinement. Printed by `arena refine`. */
export function renderRefineBrief(ctx: RefineContext): string {
  const out: string[] = []
  out.push("# Arena — task refinement brief", "")
  out.push("## Original request", "", ctx.task, "")
  out.push("## Repository", "")
  if (ctx.repository) {
    const r = ctx.repository
    out.push(`- root: ${r.root}`)
    out.push(`- branch: ${r.branch ?? "(detached)"} @ ${r.headCommit.slice(0, 12)}${r.dirty ? " (uncommitted changes; candidates start from HEAD)" : ""}`)
  } else {
    out.push(`- ${ctx.repositoryError ?? "not a git repository"}`)
  }
  for (const kind of ["test", "lint", "typecheck"] as const) out.push(`- ${kind}: ${ctx.verify[kind] ? "`" + ctx.verify[kind] + "`" : "(none detected)"}`)
  out.push(`- setup: ${ctx.setup.length ? "`" + ctx.setup.join(" && ") + "`" : "(none)"}`)
  if (ctx.layout.length) out.push(`- top level: ${ctx.layout.join("  ")}`)
  out.push(`- default mode: ${ctx.defaultMode}${ctx.defaultMode === "simple" ? " (config `refine: false`)" : ""}`)
  if (ctx.draftPath) out.push(`- original request saved to: ${ctx.draftPath}`)
  out.push("")
  out.push("## Why", "")
  out.push(
    "Runners work headless and cannot ask anything. Every gap in the request becomes a guess, and two runners guess differently, which makes the candidates hard to compare. Close the gaps now: runners receive only the specification you write; the original request is stored with the session for reviewers. Until the user confirms the specification, do not create worktrees, run setup, launch runners, or implement anything.",
    "",
  )
  out.push("## Procedure", "")
  out.push("1. Understand — restate the request in one sentence. Read the code it touches (read-only): entry points, the modules to change, existing tests, naming and error-handling conventions. Candidates start from HEAD: for dirty or untracked files look at the committed version (git show HEAD:<path>) and do not rely on changes the runners will not receive.")
  out.push("2. Find the gaps — list every decision a runner would otherwise have to guess: scope boundaries, files and modules affected, behavior in edge cases, public API and naming, backward compatibility, user-facing text, which tests are expected, what must not change.")
  out.push("3. Settle what you can — from the code, the project's conventions, and sensible defaults. Record each such decision.")
  out.push("4. Ask the user only what remains — batch the questions (a few per round, each with concrete options and a recommended default), at most two rounds. If the user defers (\"you decide\", \"お任せ\"), choose and record the choice. If nothing is unclear, skip the questions and say so.")
  out.push("5. Write the specification with the template below — integrate the answers, no Q&A transcript, keep the user's language and exact identifiers, omit empty sections, and make it self-contained (runners cannot see this conversation). Be concrete about what must be true; leave how open so the runners can take different approaches. Never invent requirements or silently drop a conflicting one. Scale the detail to the task.")
  out.push("6. Confirm — show the specification and let the user choose: launch with it, edit it, send the original request as is (simple mode; never a half-refined draft), or cancel.")
  out.push("7. Launch — the original request is recorded alongside the specification:")
  out.push("")
  out.push("```bash")
  out.push(`arena start --players <p1>,<p2> --original-task-file ${ctx.draftPath ?? "<original.md>"} --json <<'ARENA_TASK'`)
  out.push("<refined specification>")
  out.push("ARENA_TASK")
  out.push("```")
  out.push("")
  out.push("Simple mode instead (request passed verbatim, no original recorded): `arena start --players <p1>,<p2> --task-file " + (ctx.draftPath ?? "<original.md>") + "`", "")
  out.push("## Specification template", "", "```markdown", REFINED_TASK_TEMPLATE.trimEnd(), "```", "")
  return out.join("\n")
}
