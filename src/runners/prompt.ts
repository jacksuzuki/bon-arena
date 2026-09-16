/** Shared rules prepended to every runner prompt so both players compete under the same conditions. */
export function buildArenaPrompt(task: string): string {
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

TASK:
${task}
`
}
