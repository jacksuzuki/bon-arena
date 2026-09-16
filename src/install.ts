import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** Copy the bundled skill so it also survives removal of an npx cache or local checkout. */
export function installSkill(options: { configDir?: string; force?: boolean } = {}): { path: string; changed: boolean } {
  const source = readFileSync(new URL("../.claude/skills/arena/SKILL.md", import.meta.url), "utf8")
  const configDir = resolve(options.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"))
  const directory = join(configDir, "skills", "arena")
  const path = join(directory, "SKILL.md")
  const directoryStat = lstatSync(directory, { throwIfNoEntry: false })
  const conflict = () => new Error(`Skill already exists at ${directory}. Use --force to replace it.`)

  // Older installations used a symlink to a checkout. Never write through that link.
  if (directoryStat?.isSymbolicLink()) {
    if (!options.force) throw conflict()
    unlinkSync(directory)
  } else if (directoryStat && !directoryStat.isDirectory()) {
    throw new Error(`Skill destination is not a directory: ${directory}`)
  }

  mkdirSync(directory, { recursive: true })
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (existing) {
    if (existing.isFile() && readFileSync(path, "utf8") === source) return { path, changed: false }
    if (!options.force) throw conflict()
    if (!existing.isFile() && !existing.isSymbolicLink()) throw new Error(`Skill destination is not a file: ${path}`)
    // Unlink first, including for files, to avoid modifying symlink or hard-link targets.
    unlinkSync(path)
  }
  writeFileSync(path, source, { flag: "wx" })
  return { path, changed: true }
}
