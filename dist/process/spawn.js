import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/** Environment for runner subprocesses: inherit, drop the parent Claude Code session markers, add overrides. */
export function runnerEnvironment(extra = {}) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined)
            continue;
        // Runners must not believe they run nested inside the host Claude Code session.
        if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_"))
            continue;
        env[k] = v;
    }
    return { ...env, ...extra };
}
function supervisorPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const ts = join(here, "supervisor.ts");
    return existsSync(ts) ? ts : join(here, "supervisor.js");
}
/**
 * Launch a runner in its own detached process group supervised by supervisor.ts.
 * Returns the supervisor pid; the runner outlives the current process.
 */
export function spawnDetached(opts) {
    mkdirSync(dirname(opts.stdoutPath), { recursive: true });
    const spec = {
        command: opts.command,
        args: opts.args,
        cwd: opts.cwd,
        env: runnerEnvironment(opts.env),
        promptPath: opts.promptPath,
        promptViaStdin: opts.promptViaStdin,
        stdoutPath: opts.stdoutPath,
        stderrPath: opts.stderrPath,
        exitCodePath: opts.exitCodePath,
    };
    writeFileSync(opts.specPath, JSON.stringify(spec, null, 2));
    const child = spawn(process.execPath, [supervisorPath(), opts.specPath], {
        cwd: opts.cwd,
        detached: true,
        stdio: "ignore",
        env: spec.env,
    });
    child.unref();
    if (child.pid === undefined) {
        throw new Error(`Failed to spawn supervisor for ${opts.command}`);
    }
    return child.pid;
}
export function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
export function readExitCode(exitCodePath) {
    if (!existsSync(exitCodePath))
        return null;
    const raw = readFileSync(exitCodePath, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 1;
}
/** Terminate a supervisor and everything in its process group. */
export function killProcessGroup(pid, signal = "SIGTERM") {
    try {
        process.kill(-pid, signal);
        return true;
    }
    catch {
        try {
            process.kill(pid, signal);
            return true;
        }
        catch {
            return false;
        }
    }
}
