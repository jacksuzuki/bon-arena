/** Exercise the exact archive users install, in a disposable installation prefix. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const temporary = mkdtempSync(join(root, ".arena-package-test-"))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, "Run this check with npm run test:package")
function run(command, args, cwd = temporary, env = process.env) {
  return execFileSync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

try {
  // Build already ran. Skip lifecycle scripts to keep npm pack's JSON output machine-readable.
  const [packed] = JSON.parse(run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temporary], root))
  const files = packed.files.map((file) => file.path)
  for (const required of ["dist/arena.js", "dist/install.js", "dist/process/supervisor.js", ".claude/skills/arena/SKILL.md"]) {
    assert.ok(files.includes(required), `Missing packaged file: ${required}`)
  }
  assert.ok(!files.some((file) => file.startsWith("src/") || file.startsWith("test/")))

  const prefix = join(temporary, "prefix with spaces")
  run(process.execPath, [npmCli, "install", "--global", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", join(temporary, packed.filename)])
  const bin = process.platform === "win32" ? prefix : join(prefix, "bin")
  const executable = join(bin, process.platform === "win32" ? "arena.cmd" : "arena")
  const moduleRoot = process.platform === "win32" ? join(prefix, "node_modules") : join(prefix, "lib/node_modules")
  const installed = join(moduleRoot, "ccc-arena")
  assert.ok(existsSync(executable), "npm did not create the arena command")
  assert.ok(!existsSync(join(installed, "node_modules/typescript")), "Installed development dependencies")
  const home = join(temporary, "claude config")
  const env = { ...process.env, CLAUDE_CONFIG_DIR: home, PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}` }
  // Windows .cmd shims need a shell; exercise their JS target directly on Windows.
  const arena = (args) => process.platform === "win32"
    ? run(process.execPath, [join(installed, "dist/arena.js"), ...args], temporary, env)
    : run(executable, args, temporary, env)
  assert.match(arena(["--help"]), /arena install-skill/)
  assert.match(arena(["install-skill"]), /Installed:/)
  assert.equal(readFileSync(join(home, "skills/arena/SKILL.md"), "utf8"), readFileSync(join(root, ".claude/skills/arena/SKILL.md"), "utf8"))
  assert.match(arena(["install-skill"]), /Already installed:/)
  // Ensure the CLI works with runtime dependencies alone, after its archive is gone.
  rmSync(join(temporary, packed.filename))
  assert.match(arena(["help"]), /arena doctor/)
  console.log("Package smoke test passed: archive contents, global CLI, skill installation and repeat installation.")
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
