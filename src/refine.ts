/**
 * Task refinement support.
 *
 * Arena Core never calls a model. Refinement — understanding the user's request, asking about
 * unclear points and turning it into a specification that runners can implement in one shot — is
 * done by the host (e.g. the Claude Code /arena skill). The host settles *what* is wanted (intent,
 * the user's decisions, observable acceptance); investigation and design stay with the runners,
 * because a best-of-N comparison is only worth something when the candidates are independent. This module gives every host the same
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

/**
 * Skeleton the host fills in. It fixes what the user wants, so every runner reads the same contract,
 * and deliberately has no place for a design: how to build it is what the runners compete on.
 */
export const REFINED_TASK_TEMPLATE = `# <title: one line, imperative>

## Goal
<what must be true when the task is done, in one or two sentences>

## Context
<only what a runner cannot find in the repository: why the change is wanted, facts from the user, external constraints. Do not describe the code; runners read it themselves>

## Scope
- In: <outcomes to deliver, one per line — not the files or functions to edit>
- Out (non-goals): <things a runner might be tempted to do but must not>

## Requirements
1. <behavior as seen from outside: commands, inputs and outputs, user-facing names and text, error cases. Names and interfaces only where they are public or the user fixed them>
2. …

## Acceptance criteria
- [ ] <check on observable behavior that any good implementation would pass; include the exact command when there is one. Never assert internal structure (function names, argument layout, file placement)>
- [ ] …

## Constraints
- <compatibility to preserve, files not to touch, conventions to follow, dependencies allowed>

## Verification
- <commands that must pass; that new behavior needs tests — not which tests>

## Decisions
- <question that was open> → <decision> (<user / default>)

## Open to the implementer
- <design choices you noticed and deliberately leave open: approach, structure, internal naming, …>

## Notes (unverified)
- <optional. Findings of yours about how it could be built. Runners are told these are hints to check, not requirements. Leave out anything a runner finds by reading the code>
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
    "Runners work headless and cannot ask anything. Every gap in what the user wants becomes a guess, and each runner guesses differently, which makes the candidates hard to compare. Close those gaps now: runners receive only the specification you write; the original request is stored with the session for reviewers. But stop there. An arena is a best-of-N: its value is that independent runners investigate and design differently, and anything you investigate or design for them is shared by every candidate — including your mistakes. Settle what is wanted; leave how to build it to the runners. Until the user confirms the specification, do not create worktrees, run setup, launch runners, or implement anything.",
    "",
  )
  out.push("## Procedure", "")
  out.push("1. Understand — restate the request in one sentence. Read code (read-only) only as far as needed to see what the request means here and where it is ambiguous; do not work out the implementation, and do not probe tools or APIs on the runners' behalf. Candidates start from HEAD: for dirty or untracked files look at the committed version (git show HEAD:<path>) and do not rely on changes the runners will not receive.")
  out.push("2. Find the gaps — list the decisions about what is wanted that a runner would otherwise have to guess: scope boundaries, behavior in edge cases, public API and user-facing names and text, backward compatibility, what must not change. Decisions about how (which files, which structure, which internal names, which approach) are not gaps; they go under \"Open to the implementer\".")
  out.push("3. Settle what you can — from the project's conventions and sensible defaults, for the gaps of step 2 only. Record each such decision.")
  out.push("4. Ask the user only what remains — batch the questions (a few per round, each with concrete options and a recommended default), at most two rounds. If the user defers (\"you decide\", \"お任せ\"), choose and record the choice. If nothing is unclear, skip the questions and say so.")
  out.push("5. Write the specification with the template below — integrate the answers, no Q&A transcript, keep the user's language and exact identifiers, omit empty sections, and make it self-contained (runners cannot see this conversation). Be concrete about what must be true; leave how open so the runners can take different approaches. Test every line: would a different, equally good implementation violate it? If so, and neither the user nor a public contract demands it, delete the line or move it to \"Open to the implementer\". Implementation facts you happened to learn go under \"Notes (unverified)\" or nowhere. Never invent requirements or silently drop a conflicting one. Scale the detail to the task.")
  out.push("6. Confirm — show the specification and let the user choose: launch with it, edit it, or cancel. Simple mode is chosen up front (e.g. `task --simple`), never at this step, and a half-refined draft is never sent.")
  out.push("7. Launch — the original request is recorded alongside the specification:")
  out.push("")
  out.push("```bash")
  out.push(`arena start --players <p1>,<p2>[,<p3>] --original-task-file ${ctx.draftPath ?? "<original.md>"} --json <<'ARENA_TASK'`)
  out.push("<refined specification>")
  out.push("ARENA_TASK")
  out.push("```")
  out.push("")
  out.push("Simple mode instead (request passed verbatim, no original recorded): `arena start --players <p1>,<p2>[,<p3>] --task-file " + (ctx.draftPath ?? "<original.md>") + "`", "")
  out.push("## Specification template", "", "```markdown", REFINED_TASK_TEMPLATE.trimEnd(), "```", "")
  return out.join("\n")
}
