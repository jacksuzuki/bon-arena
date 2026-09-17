import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
function detectPackageManager(root, pkg) {
    const pm = pkg.packageManager?.split("@")[0];
    if (pm === "bun" || pm === "pnpm" || pm === "yarn" || pm === "npm")
        return pm;
    if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb")))
        return "bun";
    if (existsSync(join(root, "pnpm-lock.yaml")))
        return "pnpm";
    if (existsSync(join(root, "yarn.lock")))
        return "yarn";
    return "npm";
}
function runScript(pm, script) {
    return `${pm} run ${script}`;
}
function execBin(pm, bin) {
    switch (pm) {
        case "bun":
            return `bunx ${bin}`;
        case "pnpm":
            return `pnpm exec ${bin}`;
        case "yarn":
            return `yarn ${bin}`;
        default:
            return `npx ${bin}`;
    }
}
const NPM_PLACEHOLDER_TEST = /no test specified/i;
/** Guess test / lint / typecheck commands from the repository contents. */
export function detectVerifyCommands(root) {
    const out = {};
    const pkgPath = join(root, "package.json");
    if (existsSync(pkgPath)) {
        let pkg = {};
        try {
            pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        }
        catch {
            pkg = {};
        }
        const pm = detectPackageManager(root, pkg);
        const scripts = pkg.scripts ?? {};
        if (scripts.test && !NPM_PLACEHOLDER_TEST.test(scripts.test)) {
            out.test = `${pm} test`;
        }
        else if (pm === "bun") {
            out.test = "bun test";
        }
        if (scripts.lint)
            out.lint = runScript(pm, "lint");
        const typecheckScript = ["typecheck", "type-check", "check-types", "tsc"].find((s) => scripts[s]);
        if (typecheckScript) {
            out.typecheck = runScript(pm, typecheckScript);
        }
        else if (existsSync(join(root, "tsconfig.json"))) {
            const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
            if (deps.typescript)
                out.typecheck = execBin(pm, "tsc --noEmit -p tsconfig.json");
        }
        return out;
    }
    if (existsSync(join(root, "Cargo.toml"))) {
        out.test = "cargo test";
        out.typecheck = "cargo check";
        return out;
    }
    if (existsSync(join(root, "go.mod"))) {
        out.test = "go test ./...";
        out.lint = "go vet ./...";
        return out;
    }
    if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "pytest.ini")) || existsSync(join(root, "setup.cfg"))) {
        out.test = "pytest -q";
        return out;
    }
    return out;
}
/**
 * Guess how to prepare a fresh worktree so runners and verification see installed dependencies.
 * Only package-manager installs are detected; compiled languages fetch on build.
 */
export function detectSetupCommands(root) {
    const pkgPath = join(root, "package.json");
    if (!existsSync(pkgPath))
        return [];
    let pkg = {};
    try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    }
    catch {
        pkg = {};
    }
    const pm = detectPackageManager(root, pkg);
    switch (pm) {
        case "bun":
            return ["bun install --frozen-lockfile"];
        case "pnpm":
            return ["pnpm install --frozen-lockfile"];
        case "yarn":
            return ["yarn install --frozen-lockfile"];
        default:
            return [existsSync(join(root, "package-lock.json")) ? "npm ci" : "npm install"];
    }
}
/** Precedence: CLI override > repository/user config > auto detection. `false` disables setup. */
export function resolveSetupCommands(root, config, override) {
    const value = override !== undefined ? override : config !== undefined ? config : detectSetupCommands(root);
    if (value === false)
        return [];
    const list = typeof value === "string" ? [value] : value;
    return list.map((c) => c.trim()).filter(Boolean);
}
/** Precedence: CLI overrides > repository/user config > auto detection. `false` disables a check. */
export function resolveVerifyCommands(root, config, overrides = {}) {
    const detected = detectVerifyCommands(root);
    const out = {};
    for (const kind of ["test", "lint", "typecheck"]) {
        const value = overrides[kind] !== undefined ? overrides[kind] : config[kind] !== undefined ? config[kind] : detected[kind];
        if (typeof value === "string" && value.trim())
            out[kind] = value.trim();
    }
    return out;
}
