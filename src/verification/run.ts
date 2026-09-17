import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import type { VerificationResult, VerifyCommands } from "../session.ts"
import { runnerEnvironment } from "../process/spawn.ts"

export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000

export function runVerification(
  command: string,
  cwd: string,
  logPath: string,
  timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS,
  opts: { append?: boolean } = {},
): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const started = Date.now()
    const log = createWriteStream(logPath, { flags: opts.append ? "a" : "w" })
    log.write(`$ ${command}\n\n`)
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...runnerEnvironment(), CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      detached: true,
    })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, timeoutMs)

    const done = (exitCode: number | null) => {
      clearTimeout(timer)
      const durationMs = Date.now() - started
      log.write(`\n[arena] exit ${exitCode ?? "signal"} after ${Math.round(durationMs / 1000)}s${timedOut ? " (timed out)" : ""}\n`)
      log.end()
      resolve({ command, exitCode, passed: exitCode === 0 && !timedOut, durationMs, logPath, timedOut })
    }
    child.on("error", (err) => {
      log.write(`[arena] failed to start: ${err.message}\n`)
      done(127)
    })
    child.on("exit", (code) => done(code))
  })
}

export type VerifyKind = keyof VerifyCommands

export async function runAllVerifications(
  commands: VerifyCommands,
  cwd: string,
  logPathFor: (kind: VerifyKind) => string,
  timeoutMs?: number,
  onStart?: (kind: VerifyKind, command: string) => void,
): Promise<Partial<Record<VerifyKind, VerificationResult>>> {
  const results: Partial<Record<VerifyKind, VerificationResult>> = {}
  for (const kind of ["test", "lint", "typecheck"] as const) {
    const command = commands[kind]
    if (!command) continue
    onStart?.(kind, command)
    results[kind] = await runVerification(command, cwd, logPathFor(kind), timeoutMs)
  }
  return results
}
