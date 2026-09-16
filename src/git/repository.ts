import { execFileSync, type ExecFileSyncOptions } from "node:child_process"
import { basename } from "node:path"

export interface GitResult {
  stdout: string
  exitCode: number
}

/** Run git and return stdout. Throws on non-zero exit. */
export function git(cwd: string, args: string[], opts: ExecFileSyncOptions = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  }).toString()
}

/** Run git, never throw; returns stdout and exit code. */
export function gitTry(cwd: string, args: string[]): GitResult {
  try {
    return { stdout: git(cwd, args), exitCode: 0 }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string }
    return { stdout: e.stdout?.toString() ?? "", exitCode: e.status ?? 1 }
  }
}

export interface RepositoryInfo {
  root: string
  projectName: string
  headCommit: string
  branch: string | null
  dirty: boolean
}

export function inspectRepository(path: string): RepositoryInfo {
  const inside = gitTry(path, ["rev-parse", "--is-inside-work-tree"])
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    throw new Error(`Not a git repository: ${path}`)
  }
  const root = git(path, ["rev-parse", "--show-toplevel"]).trim()
  const head = gitTry(root, ["rev-parse", "HEAD"])
  if (head.exitCode !== 0) {
    throw new Error(`Repository has no commits yet: ${root}`)
  }
  const branchOut = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()
  const status = git(root, ["status", "--porcelain"])
  return {
    root,
    projectName: basename(root),
    headCommit: head.stdout.trim(),
    branch: branchOut === "HEAD" ? null : branchOut,
    dirty: status.trim().length > 0,
  }
}
