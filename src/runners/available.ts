import { execFileSync } from "node:child_process"

export function commandExists(command: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

export function commandVersion(command: string): string | null {
  try {
    return execFileSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 })
      .toString()
      .trim()
      .split("\n")[0] ?? null
  } catch {
    return null
  }
}
