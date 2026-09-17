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
