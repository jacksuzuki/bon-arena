/** Shared rules prepended to every runner prompt so both players compete under the same conditions. */
export function buildArenaPrompt(task, opts = {}) {
    const taskNote = opts.refined
        ? `The task below is a specification that was refined together with the user before this run.
Treat it as authoritative: implement what it says, respect its scope, non-goals and recorded decisions,
and settle any remaining detail yourself in the spirit of the specification.

`
        : "";
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
`;
}
/**
 * Follow-up prompt for `arena ask`: the runner's finished conversation is resumed inside its
 * worktree with a reviewer's question. Answering is strictly read-only; changes would invalidate
 * the collected results.
 */
export function buildAskPrompt(question) {
    return `A reviewer is comparing your implementation with another candidate and has a question about it.

Answer the question below directly and concretely. Refer to specific files, functions and lines
where that helps. If the question points at a bug, a gap or an unmet requirement, say so plainly,
explain the cause and what a fix would involve, but do NOT apply it.

This is a read-only exchange: do not create, modify or delete any file, do not run commands that
change the working tree, do not commit, and do not switch branches. Inspect only.

QUESTION:
${question.trim()}
`;
}
