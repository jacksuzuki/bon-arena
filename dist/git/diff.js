import { writeFileSync } from "node:fs";
import { git, gitTry } from "./repository.js";
export function parseNumstat(numstat) {
    const files = [];
    for (const line of numstat.split("\n")) {
        if (!line.trim())
            continue;
        const [a, d, ...rest] = line.split("\t");
        const path = rest.join("\t");
        if (!path)
            continue;
        files.push({
            path,
            additions: a === "-" ? 0 : Number(a),
            deletions: d === "-" ? 0 : Number(d),
        });
    }
    return files;
}
export function summarize(files, commits) {
    return {
        changedFiles: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        commits,
        files,
    };
}
/**
 * Collect the diff of a worktree against the base commit, covering committed,
 * staged, unstaged and untracked changes. Untracked files are registered with
 * intent-to-add so they appear in the diff.
 */
export function collectDiff(worktree, baseCommit, diffPath, statusPath) {
    const status = git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"]);
    writeFileSync(statusPath, status);
    // Register untracked files so `git diff` sees them. Ignored files stay ignored.
    gitTry(worktree, ["add", "--intent-to-add", "--all"]);
    const numstat = git(worktree, ["diff", "--numstat", baseCommit]);
    const diff = git(worktree, ["diff", baseCommit]);
    writeFileSync(diffPath, diff);
    const commitsOut = gitTry(worktree, ["rev-list", "--count", `${baseCommit}..HEAD`]);
    const commits = commitsOut.exitCode === 0 ? Number(commitsOut.stdout.trim()) || 0 : 0;
    return summarize(parseNumstat(numstat), commits);
}
