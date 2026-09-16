import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { git, gitTry } from "./repository.ts"

export function createWorktree(repo: string, path: string, branch: string, baseCommit: string): void {
  if (existsSync(path)) {
    throw new Error(`Worktree path already exists: ${path}`)
  }
  const exists = gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])
  if (exists.exitCode === 0) {
    throw new Error(`Branch already exists: ${branch}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  git(repo, ["worktree", "add", "-b", branch, path, baseCommit])
}

export function removeWorktree(repo: string, path: string): void {
  if (existsSync(path)) {
    git(repo, ["worktree", "remove", "--force", path])
  }
  gitTry(repo, ["worktree", "prune"])
}

export function deleteBranch(repo: string, branch: string): boolean {
  return gitTry(repo, ["branch", "-D", branch]).exitCode === 0
}

export function listWorktrees(repo: string): string[] {
  return git(repo, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
}
