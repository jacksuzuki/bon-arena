/**
 * Arena Core: isolate / run / collect / compare.
 * Harness-independent. Every function here is usable from any host (Claude Code skill, CLI, ...).
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, type ArenaConfig } from "./config.ts"
import { collectDiff } from "./git/diff.ts"
import { inspectRepository, gitTry, git } from "./git/repository.ts"
import { createWorktree, deleteBranch, removeWorktree } from "./git/worktree.ts"
import { arenaDir } from "./paths.ts"
import { isProcessAlive, killProcessGroup, readExitCode, spawnDetached } from "./process/spawn.ts"
import { createRunnerRegistry, resolveRunner } from "./runners/index.ts"
import { buildArenaPrompt } from "./runners/prompt.ts"
import type { ArenaRunner } from "./runners/types.ts"
import { findPlayer, loadSession, newArenaId, saveSession, type Player, type Session } from "./session.ts"
import { resolveSetupCommands, resolveVerifyCommands, type SetupOverride, type VerifyOverrides } from "./verification/detect.ts"
import { runAllVerifications, runVerification, DEFAULT_VERIFY_TIMEOUT_MS, type VerifyKind } from "./verification/run.ts"

export interface StartOptions {
  repo: string
  task: string
  players: string[]
  verify?: VerifyOverrides
  /** Worktree preparation commands; `false` skips, undefined uses config / auto-detection. */
  setup?: SetupOverride
  setupTimeoutMs?: number
  log?: (line: string) => void
}

export interface RunnerAvailability {
  id: string
  label: string
  command: string
  available: boolean
}

export async function checkRunners(repo: string): Promise<RunnerAvailability[]> {
  const config = loadConfig(repo)
  const registry = createRunnerRegistry(config)
  const out: RunnerAvailability[] = []
  for (const r of registry.values()) {
    out.push({
      id: r.id,
      label: r.label,
      command: r.invocation({ prompt: "", task: "", cwd: repo, branch: "", arenaId: "", promptPath: "", resultsDir: "" }).command,
      available: await r.isAvailable(),
    })
  }
  return out
}

function uniquePlayerIds(runnerIds: string[]): string[] {
  const seen = new Map<string, number>()
  return runnerIds.map((id) => {
    const n = (seen.get(id) ?? 0) + 1
    seen.set(id, n)
    return n === 1 ? id : `${id}-${n}`
  })
}

/** Create the session, worktrees and launch every player. Returns immediately; runners keep going. */
export async function startArena(opts: StartOptions): Promise<Session> {
  const log = opts.log ?? (() => {})
  if (!opts.task.trim()) throw new Error("Task must not be empty")
  if (opts.players.length < 1) throw new Error("At least one player is required")

  const repo = inspectRepository(opts.repo)
  const config: ArenaConfig = loadConfig(repo.root)
  const registry = createRunnerRegistry(config)
  const runners: ArenaRunner[] = opts.players.map((id) => resolveRunner(registry, id))
  for (const r of runners) {
    if (!(await r.isAvailable())) {
      throw new Error(`Runner "${r.id}" is not available (command not found). Run: arena doctor`)
    }
  }
  if (repo.dirty) {
    log("warning: repository has uncommitted changes; candidates start from HEAD and will not see them")
  }

  const id = newArenaId()
  const dir = arenaDir(repo.projectName, id)
  const logsDir = join(dir, "logs")
  const resultsDir = join(dir, "results")
  mkdirSync(logsDir, { recursive: true })
  mkdirSync(resultsDir, { recursive: true })
  writeFileSync(join(dir, "task.md"), opts.task.trim() + "\n")

  const verify = resolveVerifyCommands(repo.root, config.verify, opts.verify)
  const setup = resolveSetupCommands(repo.root, config.setup, opts.setup)
  const playerIds = uniquePlayerIds(runners.map((r) => r.id))

  const session: Session = {
    id,
    repository: repo.root,
    projectName: repo.projectName,
    baseBranch: repo.branch,
    baseCommit: repo.headCommit,
    task: opts.task.trim(),
    status: "created",
    players: [],
    verify,
    setup,
    arenaDir: dir,
    startedAt: new Date().toISOString(),
    selected: null,
  }

  // 1. isolate
  for (let i = 0; i < runners.length; i++) {
    const runner = runners[i]!
    const playerId = playerIds[i]!
    const branch = `arena/${id}/${playerId}`
    const worktree = join(dir, playerId)
    log(`creating worktree ${worktree} (branch ${branch})`)
    createWorktree(repo.root, worktree, branch, repo.headCommit)
    session.players.push({
      id: playerId,
      runner: runner.id,
      label: runners.length > 1 && playerIds.filter((p) => p.startsWith(runner.id)).length > 1 ? `${runner.label} #${i + 1}` : runner.label,
      branch,
      worktree,
      status: "pending",
      promptPath: join(dir, `${playerId}.prompt.md`),
      stdoutPath: join(logsDir, `${playerId}.stdout.log`),
      stderrPath: join(logsDir, `${playerId}.stderr.log`),
      exitCodePath: join(logsDir, `${playerId}.exit`),
    })
  }
  saveSession(session)

  // 2. prepare: install dependencies etc. so runners and verification see a usable checkout
  if (setup.length > 0) {
    log(`running setup in each worktree: ${setup.join(" && ")}`)
    const timeout = opts.setupTimeoutMs ?? (config.verify.timeout ? config.verify.timeout * 1000 : DEFAULT_VERIFY_TIMEOUT_MS)
    const results = await Promise.all(
      session.players.map(async (player) => {
        const logPath = join(logsDir, `${player.id}.setup.log`)
        const started = Date.now()
        let passed = true
        for (const command of setup) {
          const r = await runVerification(command, player.worktree, logPath, timeout, { append: true })
          if (!r.passed) {
            passed = false
            break
          }
        }
        player.setup = { commands: setup, passed, durationMs: Date.now() - started, logPath }
        return player
      }),
    )
    saveSession(session)
    const failed = results.filter((p) => !p.setup?.passed)
    if (failed.length > 0) {
      for (const p of session.players) {
        try {
          removeWorktree(repo.root, p.worktree)
          deleteBranch(repo.root, p.branch)
        } catch {
          /* best effort */
        }
      }
      session.status = "cleaned"
      saveSession(session)
      throw new Error(
        `setup failed for ${failed.map((p) => p.label).join(", ")} (see ${failed.map((p) => p.setup?.logPath).join(", ")}). ` +
          `Fix the setup command, set "setup: false" in .arena.yaml, or pass --no-setup.`,
      )
    }
    log(`setup done (${results.map((p) => `${p.label} ${Math.round((p.setup?.durationMs ?? 0) / 1000)}s`).join(", ")})`)
  }

  // 3. run
  const prompt = buildArenaPrompt(session.task)
  for (let i = 0; i < runners.length; i++) {
    const runner = runners[i]!
    const player = session.players[i]!
    writeFileSync(player.promptPath, prompt)
    const invocation = runner.invocation({
      prompt,
      task: session.task,
      cwd: player.worktree,
      branch: player.branch,
      arenaId: id,
      promptPath: player.promptPath,
      resultsDir,
    })
    const pid = spawnDetached({
      command: invocation.command,
      args: invocation.args,
      cwd: player.worktree,
      env: { ...(invocation.env ?? {}), ARENA_ID: id, ARENA_PLAYER: player.id, ARENA_WORKTREE: player.worktree },
      promptPath: player.promptPath,
      promptViaStdin: invocation.promptViaStdin,
      stdoutPath: player.stdoutPath,
      stderrPath: player.stderrPath,
      exitCodePath: player.exitCodePath,
      specPath: join(logsDir, `${player.id}.spec.json`),
    })
    player.pid = pid
    player.status = "running"
    player.startedAt = new Date().toISOString()
    player.command = [invocation.command, ...invocation.args].join(" ")
    log(`started ${player.label} (pid ${pid})`)
  }
  session.status = "running"
  saveSession(session)
  return session
}

/** Re-read exit files / pids and update player + session status. Persists changes. */
export function refreshSession(id: string): Session {
  const session = loadSession(id)
  let changed = false
  for (const p of session.players) {
    if (p.status !== "running") continue
    const code = readExitCode(p.exitCodePath)
    if (code !== null) {
      p.exitCode = code
      p.status = code === 0 ? "completed" : "failed"
      p.finishedAt = p.finishedAt ?? new Date().toISOString()
      changed = true
    } else if (p.pid !== undefined && !isProcessAlive(p.pid)) {
      p.exitCode = null
      p.status = "failed"
      p.finishedAt = new Date().toISOString()
      changed = true
    }
  }
  if (session.status === "running" && session.players.every((p) => p.status !== "running" && p.status !== "pending")) {
    session.status = "finished"
    session.finishedAt = new Date().toISOString()
    changed = true
  }
  if (changed) saveSession(session)
  return session
}

export function isSessionActive(session: Session): boolean {
  return session.players.some((p) => p.status === "running" || p.status === "pending")
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
  onTick?: (session: Session) => void
  signal?: AbortSignal
}

/** Poll until every player finished (or timeout / abort). */
export async function waitForArena(id: string, opts: WaitOptions = {}): Promise<Session> {
  const interval = opts.intervalMs ?? 2000
  const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity
  let session = refreshSession(id)
  while (isSessionActive(session)) {
    if (opts.signal?.aborted) break
    if (Date.now() > deadline) throw new Error(`Timed out waiting for arena ${id}`)
    opts.onTick?.(session)
    await new Promise((r) => setTimeout(r, interval))
    session = refreshSession(id)
  }
  opts.onTick?.(session)
  return session
}

export function stopArena(id: string): Session {
  const session = refreshSession(id)
  for (const p of session.players) {
    if (p.status !== "running" || p.pid === undefined) continue
    killProcessGroup(p.pid, "SIGTERM")
    p.status = "stopped"
    p.finishedAt = new Date().toISOString()
  }
  session.status = "stopped"
  session.finishedAt = session.finishedAt ?? new Date().toISOString()
  saveSession(session)
  // Escalate for anything that ignored SIGTERM.
  setTimeout(() => {
    for (const p of session.players) {
      if (p.pid !== undefined && isProcessAlive(p.pid)) killProcessGroup(p.pid, "SIGKILL")
    }
  }, 3000).unref()
  return session
}

export interface CollectOptions {
  players?: string[]
  verify?: VerifyOverrides
  skipVerification?: boolean
  timeoutMs?: number
  log?: (line: string) => void
}

/** Gather diff stats and run verification for finished players. */
export async function collectResults(id: string, opts: CollectOptions = {}): Promise<Session> {
  const log = opts.log ?? (() => {})
  const session = refreshSession(id)
  if (opts.verify) {
    const config = loadConfig(session.repository)
    session.verify = resolveVerifyCommands(session.repository, config.verify, opts.verify)
  }
  const resultsDir = join(session.arenaDir, "results")
  mkdirSync(resultsDir, { recursive: true })
  const configTimeoutSec = loadConfig(session.repository).verify.timeout
  const effectiveTimeout = opts.timeoutMs ?? (configTimeoutSec ? configTimeoutSec * 1000 : DEFAULT_VERIFY_TIMEOUT_MS)

  const targets = opts.players?.length ? opts.players.map((p) => findPlayer(session, p)) : session.players
  for (const p of targets) {
    if (p.status === "running" || p.status === "pending") {
      log(`skipping ${p.label}: still ${p.status}`)
      continue
    }
    if (!existsSync(p.worktree)) {
      log(`skipping ${p.label}: worktree missing`)
      continue
    }
    log(`collecting ${p.label}`)
    const diffPath = join(resultsDir, `${p.id}.diff`)
    const statusPath = join(resultsDir, `${p.id}.status.txt`)
    const stats = collectDiff(p.worktree, session.baseCommit, diffPath, statusPath)
    const verification = opts.skipVerification
      ? {}
      : await runAllVerifications(session.verify, p.worktree, (kind: VerifyKind) => join(resultsDir, `${p.id}.${kind}.log`), effectiveTimeout, (kind, cmd) =>
          log(`  ${p.label}: ${kind} → ${cmd}`),
        )
    const started = p.startedAt ? Date.parse(p.startedAt) : Date.now()
    const finished = p.finishedAt ? Date.parse(p.finishedAt) : Date.now()
    p.result = {
      runnerId: p.runner,
      durationMs: Math.max(0, finished - started),
      git: { ...stats, diffPath, statusPath },
      verification,
      collectedAt: new Date().toISOString(),
    }
    saveSession(session)
  }
  if (session.players.every((p) => p.result || p.status === "running" || p.status === "pending") && !isSessionActive(session)) {
    session.status = "collected"
  }
  saveSession(session)
  return session
}

export function selectCandidate(id: string, playerRef: string | null): Session {
  const session = refreshSession(id)
  session.selected = playerRef === null ? null : findPlayer(session, playerRef).id
  saveSession(session)
  return session
}

/** Commit whatever is in the candidate worktree onto its branch so the branch is self-contained. */
export function commitCandidate(id: string, playerRef: string, message?: string): { player: Player; committed: boolean; commit: string | null } {
  const session = refreshSession(id)
  const player = findPlayer(session, playerRef)
  if (!existsSync(player.worktree)) throw new Error(`Worktree missing for ${player.id}: ${player.worktree}`)
  git(player.worktree, ["add", "--all"])
  const staged = gitTry(player.worktree, ["diff", "--cached", "--quiet"])
  if (staged.exitCode === 0) {
    return { player, committed: false, commit: gitTry(player.worktree, ["rev-parse", "HEAD"]).stdout.trim() || null }
  }
  git(player.worktree, ["commit", "--quiet", "--no-verify", "-m", message ?? `arena(${session.id}): ${player.label} candidate\n\nTask: ${session.task.split("\n")[0]}`])
  return { player, committed: true, commit: git(player.worktree, ["rev-parse", "HEAD"]).trim() }
}

export interface CleanOptions {
  /** Delete branches too (default true). The selected candidate's branch is always kept unless force. */
  deleteBranches?: boolean
  /** Also delete the selected candidate's branch and the session file. */
  force?: boolean
  log?: (line: string) => void
}

export function cleanArena(id: string, opts: CleanOptions = {}): Session {
  const log = opts.log ?? (() => {})
  const session = refreshSession(id)
  if (isSessionActive(session)) {
    stopArena(id)
  }
  for (const p of session.players) {
    if (existsSync(p.worktree)) {
      log(`removing worktree ${p.worktree}`)
      try {
        removeWorktree(session.repository, p.worktree)
      } catch (err) {
        log(`  failed: ${(err as Error).message}`)
      }
    }
    const keep = session.selected === p.id && !opts.force
    if ((opts.deleteBranches ?? true) && !keep) {
      if (deleteBranch(session.repository, p.branch)) log(`deleted branch ${p.branch}`)
    } else if (keep) {
      log(`kept branch ${p.branch} (selected)`)
    }
  }
  if (opts.force && existsSync(session.arenaDir)) {
    rmSync(session.arenaDir, { recursive: true, force: true })
    log(`removed ${session.arenaDir}`)
  }
  session.status = "cleaned"
  saveSession(session)
  return session
}
