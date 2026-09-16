/**
 * Detached supervisor for one runner process.
 *
 * Launched by the arena core with `node supervisor.ts <spec.json>`. It spawns the
 * runner with stdin from the prompt file and stdout/stderr redirected to log files,
 * waits for it, and writes the exit code file so the core can observe completion
 * even after the launching `arena` command has exited.
 */
import { spawn } from "node:child_process"
import { openSync, readFileSync, writeFileSync, closeSync } from "node:fs"

export interface SupervisorSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  promptPath: string
  promptViaStdin: boolean
  stdoutPath: string
  stderrPath: string
  exitCodePath: string
}

function main(): void {
  const specPath = process.argv[2]
  if (!specPath) {
    process.stderr.write("usage: supervisor <spec.json>\n")
    process.exit(2)
  }
  const spec = JSON.parse(readFileSync(specPath, "utf8")) as SupervisorSpec

  const stdin = spec.promptViaStdin ? openSync(spec.promptPath, "r") : "ignore"
  const stdout = openSync(spec.stdoutPath, "a")
  const stderr = openSync(spec.stderrPath, "a")

  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: [stdin, stdout, stderr],
  })

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    const exit = code ?? (signal ? 128 + 15 : 1)
    writeFileSync(spec.exitCodePath, `${exit}\n`)
    try {
      if (typeof stdin === "number") closeSync(stdin)
      closeSync(stdout)
      closeSync(stderr)
    } catch {
      /* ignore */
    }
    process.exit(exit)
  }

  child.on("error", (err) => {
    writeFileSync(spec.stderrPath, `\n[arena] failed to start ${spec.command}: ${err.message}\n`, { flag: "a" })
    finish(127, null)
  })
  child.on("exit", finish)

  const forward = (sig: NodeJS.Signals) => {
    if (!child.killed) child.kill(sig)
  }
  process.on("SIGTERM", () => forward("SIGTERM"))
  process.on("SIGINT", () => forward("SIGINT"))
  process.on("SIGHUP", () => forward("SIGTERM"))
}

main()
