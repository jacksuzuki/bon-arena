import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { VerifyConfig } from "../config.ts"
import type { VerifyCommands } from "../session.ts"

type PackageManager = "bun" | "pnpm" | "yarn" | "npm"

function detectPackageManager(root: string, pkg: { packageManager?: string }): PackageManager {
  const pm = pkg.packageManager?.split("@")[0]
  if (pm === "bun" || pm === "pnpm" || pm === "yarn" || pm === "npm") return pm
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun"
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm"
  if (existsSync(join(root, "yarn.lock"))) return "yarn"
  return "npm"
}

function runScript(pm: PackageManager, script: string): string {
  return `${pm} run ${script}`
}

function execBin(pm: PackageManager, bin: string): string {
  switch (pm) {
    case "bun":
      return `bunx ${bin}`
    case "pnpm":
      return `pnpm exec ${bin}`
    case "yarn":
      return `yarn ${bin}`
    default:
      return `npx ${bin}`
  }
}

const NPM_PLACEHOLDER_TEST = /no test specified/i

/** Guess test / lint / typecheck commands from the repository contents. */
export function detectVerifyCommands(root: string): VerifyCommands {
  const out: VerifyCommands = {}
  const pkgPath = join(root, "package.json")
  if (existsSync(pkgPath)) {
    let pkg: { scripts?: Record<string, string>; packageManager?: string; devDependencies?: Record<string, string>; dependencies?: Record<string, string> } = {}
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"))
    } catch {
      pkg = {}
    }
    const pm = detectPackageManager(root, pkg)
    const scripts = pkg.scripts ?? {}
    if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) {
      out.test = `${pm} test`
    } else if (pm === "bun") {
      out.test = "bun test"
    }
    if (scripts.lint) out.lint = runScript(pm, "lint")
    const typecheckScript = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s])
    if (typecheckScript) {
      out.typecheck = runScript(pm, typecheckScript)
    } else if (existsSync(join(root, "tsconfig.json"))) {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      if (deps.typescript) out.typecheck = execBin(pm, "tsc --noEmit -p tsconfig.json")
    }
    return out
  }
  if (existsSync(join(root, "Cargo.toml"))) {
    out.test = "cargo test"
    out.typecheck = "cargo check"
    return out
  }
  if (existsSync(join(root, "go.mod"))) {
    out.test = "go test ./..."
    out.lint = "go vet ./..."
    return out
  }
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini")) || existsSync(join(root, "setup.cfg"))) {
    out.test = "pytest -q"
    return out
  }
  return out
}

export interface VerifyOverrides {
  test?: string | false
  lint?: string | false
  typecheck?: string | false
}

/** Precedence: CLI overrides > repository/user config > auto detection. `false` disables a check. */
export function resolveVerifyCommands(root: string, config: VerifyConfig, overrides: VerifyOverrides = {}): VerifyCommands {
  const detected = detectVerifyCommands(root)
  const out: VerifyCommands = {}
  for (const kind of ["test", "lint", "typecheck"] as const) {
    const value = overrides[kind] !== undefined ? overrides[kind] : config[kind] !== undefined ? config[kind] : detected[kind]
    if (typeof value === "string" && value.trim()) out[kind] = value.trim()
  }
  return out
}
