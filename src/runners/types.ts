export interface RunnerInput {
  /** Full prompt (arena rules + task). */
  prompt: string
  /** The raw user task. */
  task: string
  /** Worktree the runner must work in. */
  cwd: string
  branch: string
  arenaId: string
  /** Path to a file containing the prompt. */
  promptPath: string
  /** Directory where the runner may write auxiliary artifacts (e.g. last message). */
  resultsDir: string
}

/** How to launch a runner. The core owns process lifecycle; runners only describe the command. */
export interface RunnerInvocation {
  command: string
  args: string[]
  /** When true the prompt is piped to the process stdin. */
  promptViaStdin: boolean
  env?: Record<string, string>
  /**
   * Identifier of the runner's own conversation when the runner chose it up front (e.g. Claude's
   * `--session-id`). Recorded with the player so the conversation can be resumed by `arena ask`.
   */
  sessionId?: string
}

export interface RunnerResult {
  runnerId: string
  exitCode: number | null
  startedAt: string
  finishedAt: string
  stdoutPath: string
  stderrPath: string
}

/** What a runner gets when its finished conversation is resumed for a follow-up question. */
export interface AskInput {
  /** The runner's own conversation id (see RunnerInvocation.sessionId / ArenaRunner.findSessionId). */
  sessionId: string
  /** Full follow-up prompt (read-only rules + question). */
  prompt: string
  promptPath: string
  /** The candidate's worktree; the conversation must be resumed with this working directory. */
  cwd: string
  resultsDir: string
}

/** Facts available when a runner has to discover its conversation id after the run. */
export interface SessionLookup {
  cwd: string
  /** ISO timestamp of the launch. */
  startedAt: string
  stdoutPath: string
  stderrPath: string
  resultsDir: string
}

export interface ArenaRunner {
  id: string
  label: string
  isAvailable(): Promise<boolean>
  /** Describe the subprocess for this task. Must not touch anything outside input.cwd / input.resultsDir. */
  invocation(input: RunnerInput): RunnerInvocation
  /**
   * Locate the runner's conversation id after the run when it was not chosen up front
   * (Codex writes its thread id to its own session store, Antigravity prints it on stdout). Return null when unknown.
   */
  findSessionId?(lookup: SessionLookup): string | null
  /**
   * Describe how to resume the finished conversation with a read-only follow-up question.
   * Absent for runners that cannot resume (custom runners without `askArgs`).
   */
  askInvocation?(input: AskInput): RunnerInvocation
}
