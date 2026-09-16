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
}

export interface RunnerResult {
  runnerId: string
  exitCode: number | null
  startedAt: string
  finishedAt: string
  stdoutPath: string
  stderrPath: string
}

export interface ArenaRunner {
  id: string
  label: string
  isAvailable(): Promise<boolean>
  /** Describe the subprocess for this task. Must not touch anything outside input.cwd / input.resultsDir. */
  invocation(input: RunnerInput): RunnerInvocation
}
