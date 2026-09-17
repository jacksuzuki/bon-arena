import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, renameSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { sessionFile, sessionsDir } from "./paths.ts"

export const VerificationResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().nullable(),
  passed: z.boolean(),
  durationMs: z.number(),
  logPath: z.string(),
  timedOut: z.boolean().default(false),
})
export type VerificationResult = z.infer<typeof VerificationResultSchema>

export const CandidateResultSchema = z.object({
  runnerId: z.string(),
  durationMs: z.number(),
  git: z.object({
    changedFiles: z.number(),
    additions: z.number(),
    deletions: z.number(),
    commits: z.number(),
    diffPath: z.string(),
    statusPath: z.string(),
    files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
  }),
  verification: z.object({
    test: VerificationResultSchema.optional(),
    lint: VerificationResultSchema.optional(),
    typecheck: VerificationResultSchema.optional(),
  }),
  collectedAt: z.string(),
})
export type CandidateResult = z.infer<typeof CandidateResultSchema>

export const PlayerStatusSchema = z.enum(["pending", "running", "completed", "failed", "stopped"])
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>

export const SetupResultSchema = z.object({
  commands: z.array(z.string()),
  passed: z.boolean(),
  durationMs: z.number(),
  logPath: z.string(),
})
export type SetupResult = z.infer<typeof SetupResultSchema>

/** One follow-up question put to a finished runner via `arena ask`, and where its answer is. */
export const AskRecordSchema = z.object({
  /** 1-based sequence number within the player. */
  n: z.number(),
  question: z.string(),
  askedAt: z.string(),
  durationMs: z.number(),
  exitCode: z.number().nullable(),
  /** Full prompt sent to the runner. */
  promptPath: z.string(),
  /** The runner's answer (stdout). */
  answerPath: z.string(),
  stderrPath: z.string(),
  timedOut: z.boolean().default(false),
  /** True when the worktree differed after the answer; results collected before are then stale. */
  worktreeChanged: z.boolean().default(false),
})
export type AskRecord = z.infer<typeof AskRecordSchema>

export const PlayerSchema = z.object({
  /** Unique within the session. Equals the runner id unless the same runner plays twice. */
  id: z.string(),
  runner: z.string(),
  label: z.string(),
  branch: z.string(),
  worktree: z.string(),
  status: PlayerStatusSchema,
  pid: z.number().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  promptPath: z.string(),
  stdoutPath: z.string(),
  stderrPath: z.string(),
  exitCodePath: z.string(),
  command: z.string().optional(),
  /** The runner's own conversation id (Claude session id / Codex thread id), once known. Lets `arena ask` resume it. */
  runnerSession: z.string().optional(),
  /** Follow-up questions answered by the runner after it finished (`arena ask`). */
  asks: z.array(AskRecordSchema).default([]),
  setup: SetupResultSchema.optional(),
  result: CandidateResultSchema.optional(),
})
export type Player = z.infer<typeof PlayerSchema>

export const VerifyCommandsSchema = z.object({
  test: z.string().optional(),
  lint: z.string().optional(),
  typecheck: z.string().optional(),
})
export type VerifyCommands = z.infer<typeof VerifyCommandsSchema>

export const SessionStatusSchema = z.enum(["created", "running", "finished", "collected", "stopped", "cleaned"])

export const SessionSchema = z.object({
  id: z.string(),
  repository: z.string(),
  projectName: z.string(),
  baseBranch: z.string().nullable(),
  baseCommit: z.string(),
  /** The task handed to the runners (the refined specification in refined mode). */
  task: z.string(),
  /**
   * "refined": the host turned the user's request into a one-shot specification before launching;
   * "simple": the request was passed to the runners verbatim.
   */
  taskMode: z.enum(["refined", "simple"]).default("simple"),
  /** The user's request as typed, kept for reviewers when `task` is a refined specification. */
  originalTask: z.string().optional(),
  status: SessionStatusSchema,
  players: z.array(PlayerSchema),
  verify: VerifyCommandsSchema,
  /** Worktree preparation commands that ran before the runners started. */
  setup: z.array(z.string()).default([]),
  arenaDir: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  selected: z.string().nullable().default(null),
  /** Host-driven finishing pass: winner used as the base, other candidates' strengths folded in. */
  synthesis: z
    .object({
      base: z.string(),
      startedAt: z.string(),
      snapshotCommit: z.string().nullable(),
      finishedAt: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
  /** Recorded when the selected branch was merged into the base branch via `arena adopt`. */
  adopted: z
    .object({ player: z.string(), mode: z.enum(["merge", "ff", "squash"]), commit: z.string(), at: z.string() })
    .optional(),
})
export type Session = z.infer<typeof SessionSchema>

export function newArenaId(now = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${y}${m}${d}-${randomBytes(3).toString("hex")}`
}

export function saveSession(session: Session): void {
  mkdirSync(sessionsDir(), { recursive: true })
  const path = sessionFile(session.id)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(session, null, 2) + "\n")
  renameSync(tmp, path)
}

export function loadSession(id: string): Session {
  const path = sessionFile(id)
  if (!existsSync(path)) {
    throw new Error(`Arena session not found: ${id} (${path})`)
  }
  return SessionSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

export function listSessions(): Session[] {
  const dir = sessionsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return SessionSchema.parse(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")))
      } catch {
        return null
      }
    })
    .filter((s): s is Session => s !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
}

/** Resolve a session id, accepting "latest" or a unique prefix. */
export function resolveSessionId(idOrPrefix: string): string {
  const all = listSessions()
  if (idOrPrefix === "latest" || idOrPrefix === "last") {
    const latest = all[0]
    if (!latest) throw new Error("No arena sessions found")
    return latest.id
  }
  if (existsSync(sessionFile(idOrPrefix))) return idOrPrefix
  const matches = all.filter((s) => s.id.startsWith(idOrPrefix))
  if (matches.length === 1) return matches[0]!.id
  if (matches.length === 0) throw new Error(`Arena session not found: ${idOrPrefix}`)
  throw new Error(`Ambiguous session id "${idOrPrefix}": ${matches.map((s) => s.id).join(", ")}`)
}

export function findPlayer(session: Session, idOrRunner: string): Player {
  const p =
    session.players.find((x) => x.id === idOrRunner) ??
    session.players.find((x) => x.runner === idOrRunner) ??
    session.players.find((x) => x.label.toLowerCase() === idOrRunner.toLowerCase())
  if (!p) {
    throw new Error(`Unknown player "${idOrRunner}". Players: ${session.players.map((x) => x.id).join(", ")}`)
  }
  return p
}
