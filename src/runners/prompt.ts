export interface ArenaPromptOptions {
  /**
   * The task is a specification refined with the user in advance (see `arena refine`).
   * Runners are told to treat it as authoritative instead of re-interpreting the request.
   */
  refined?: boolean
}

/** Shared rules prepended to every runner prompt so both players compete under the same conditions. */
export function buildArenaPrompt(task: string, opts: ArenaPromptOptions = {}): string {
  const taskNote = opts.refined
    ? `The task below is a specification that was refined together with the user before this run.
Treat it as authoritative: implement what it says, respect its scope, non-goals and recorded decisions,
and settle any remaining detail yourself in the spirit of the specification.

`
    : ""
  return `You are participating in an implementation arena.

Work only inside the current repository/worktree (the current working directory).

Implement the requested task completely.

Before finishing:
- inspect the existing implementation
- preserve existing behavior unless the task requires otherwise
- run available tests
- run typecheck/lint when applicable

Do not interact with sibling arena worktrees or any directory outside the current worktree.
Do not push, do not create remote branches, and do not switch branches.
Leave your changes in the working tree (committing on the current branch is allowed but not required).
Do not ask the user questions; make reasonable decisions and finish the task autonomously.

${taskNote}TASK:
${task}
`
}

/**
 * Follow-up prompt for `arena ask`: the runner's finished conversation is resumed inside its
 * worktree with a reviewer's question. Answering is strictly read-only; changes would invalidate
 * the collected results.
 */
export function buildAskPrompt(question: string): string {
  return `A reviewer is comparing your implementation with another candidate and has a question about it.

Answer the question below directly and concretely. Refer to specific files, functions and lines
where that helps. If the question points at a bug, a gap or an unmet requirement, say so plainly,
explain the cause and what a fix would involve, but do NOT apply it.

This is a read-only exchange: do not create, modify or delete any file, do not run commands that
change the working tree, do not commit, and do not switch branches. Inspect only.

QUESTION:
${question.trim()}
`
}

export interface ReviewPromptInput {
  /** Label of the candidate whose worktree holds the final version. */
  finalLabel: string
  finalWorktree: string
  finalBranch: string
  /** The reviewer is the selected candidate: its own worktree now holds the final version. */
  reviewerIsTarget: boolean
  /** The reviewer's own worktree (still its candidate when it is not the target). */
  reviewerWorktree: string
  /** The host edited the selected candidate (synthesis) rather than adopting it untouched. */
  synthesized: boolean
  baseCommit: string
  /** Diff from the base commit to the final version; empty when it is only available on disk. */
  diff: string
  diffPath: string
  diffTruncated: boolean
  /** Extra instructions from the host. */
  instructions?: string
}

/**
 * Prompt for `arena review`: every runner's finished conversation is resumed so it can review the
 * final version the host produced (a synthesis, or a candidate adopted as is). Read-only, with a
 * fixed answer format so the verdict can be parsed.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const origin = input.reviewerIsTarget
    ? input.synthesized
      ? "It is based on YOUR candidate: the host edited your worktree after your run, folding in the other candidate's strengths and its own changes. Your worktree now holds the final version, not your original candidate."
      : "It is YOUR candidate, adopted as is."
    : input.synthesized
      ? `It is based on the OTHER candidate: the host took that candidate as the base and folded in strengths from your candidate and its own changes. Your own worktree (${input.reviewerWorktree}) still holds your candidate and is NOT the final version.`
      : `It is the OTHER candidate, adopted as is. Your own worktree (${input.reviewerWorktree}) still holds your candidate and is NOT the final version.`
  const diffSection = input.diff.trim()
    ? [
        `Diff from the base commit ${input.baseCommit} to the final version${input.diffTruncated ? ` (truncated; full diff: ${input.diffPath})` : ""}:`,
        "",
        "```diff",
        input.diff,
        "```",
      ].join("\n")
    : `The diff from the base commit ${input.baseCommit} to the final version is at ${input.diffPath} (too large to inline; read it).`
  const extra = input.instructions?.trim() ? `\nAdditional instructions from the host:\n${input.instructions.trim()}\n` : ""
  return `The arena is over. The host (the reviewer who compared the candidates) has produced the final
version of the task and asks every runner for an independent review before it is merged.

FINAL VERSION:
- worktree: ${input.finalWorktree}
- branch: ${input.finalBranch}
- candidate: ${input.finalLabel}
- ${origin}

Review the final version against the task you were given, using what you learned while
implementing it yourself. Look for: incorrect behavior, unmet or misread requirements, regressions
of existing behavior, missing or weak tests, security or data-loss risks, and anything from your
own candidate that was dropped and actually mattered. Read files in the final worktree (absolute
paths under ${input.finalWorktree}) wherever the diff alone is not enough, and use read-only
commands such as git diff/log/show if that helps; do not run tests or builds (verification is the
host's job; if you believe a test would fail, say which and why). Do not re-litigate style or design
choices that are merely different from yours: report problems that matter, each with evidence.

ANSWER FORMAT (strict):
First line: VERDICT: approve  or  VERDICT: request-changes
Then the findings, most severe first, one per line:
- [blocker|major|minor|nit] <file>:<line> — what is wrong and why; how to fix it in one sentence
Use request-changes only when at least one blocker or major finding exists. If nothing important
is wrong, say so under VERDICT: approve and list at most a few nits. You may end with a short
section "Lost from my candidate" naming things worth restoring, if any.
${extra}
This is a read-only exchange: do not create, modify or delete any file (neither in your worktree
nor in the final worktree), do not run commands that change a working tree, do not commit, and do
not switch branches. Inspect and report only.

${diffSection}
`
}
