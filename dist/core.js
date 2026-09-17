/**
 * Arena Core: isolate / run / collect / compare.
 * Harness-independent. Every function here is usable from any host (Claude Code skill, CLI, ...).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { collectDiff } from "./git/diff.js";
import { inspectRepository, gitTry, git } from "./git/repository.js";
import { createWorktree, deleteBranch, removeWorktree } from "./git/worktree.js";
import { arenaDir } from "./paths.js";
import { isProcessAlive, killProcessGroup, readExitCode, runForeground, spawnDetached } from "./process/spawn.js";
import { createRunnerRegistry, resolveRunner } from "./runners/index.js";
import { buildArenaPrompt, buildAskPrompt, buildReviewPrompt } from "./runners/prompt.js";
import { findPlayer, loadSession, newArenaId, saveSession } from "./session.js";
import { resolveSetupCommands, resolveVerifyCommands } from "./verification/detect.js";
import { runAllVerifications, runVerification, DEFAULT_VERIFY_TIMEOUT_MS } from "./verification/run.js";
export async function checkRunners(repo) {
    const config = loadConfig(repo);
    const registry = createRunnerRegistry(config);
    const out = [];
    for (const r of registry.values()) {
        out.push({
            id: r.id,
            label: r.label,
            command: r.invocation({ prompt: "", task: "", cwd: repo, branch: "", arenaId: "", promptPath: "", resultsDir: "" }).command,
            available: await r.isAvailable(),
        });
    }
    return out;
}
function uniquePlayerIds(runnerIds) {
    const seen = new Map();
    return runnerIds.map((id) => {
        const n = (seen.get(id) ?? 0) + 1;
        seen.set(id, n);
        return n === 1 ? id : `${id}-${n}`;
    });
}
/** Create the session, worktrees and launch every player. Returns immediately; runners keep going. */
export async function startArena(opts) {
    const log = opts.log ?? (() => { });
    if (!opts.task.trim())
        throw new Error("Task must not be empty");
    if (opts.players.length < 1)
        throw new Error("At least one player is required");
    const repo = inspectRepository(opts.repo);
    const config = loadConfig(repo.root);
    const registry = createRunnerRegistry(config);
    const runners = opts.players.map((id) => resolveRunner(registry, id));
    for (const r of runners) {
        if (!(await r.isAvailable())) {
            throw new Error(`Runner "${r.id}" is not available (command not found). Run: arena doctor`);
        }
    }
    if (repo.dirty) {
        log("warning: repository has uncommitted changes; candidates start from HEAD and will not see them");
    }
    const originalTask = opts.originalTask?.trim() || undefined;
    const taskMode = originalTask !== undefined ? "refined" : "simple";
    const id = newArenaId();
    const dir = arenaDir(repo.projectName, id);
    const logsDir = join(dir, "logs");
    const resultsDir = join(dir, "results");
    mkdirSync(logsDir, { recursive: true });
    mkdirSync(resultsDir, { recursive: true });
    writeFileSync(join(dir, "task.md"), opts.task.trim() + "\n");
    if (originalTask !== undefined)
        writeFileSync(join(dir, "task.original.md"), originalTask + "\n");
    const verify = resolveVerifyCommands(repo.root, config.verify, opts.verify);
    const setup = resolveSetupCommands(repo.root, config.setup, opts.setup);
    const playerIds = uniquePlayerIds(runners.map((r) => r.id));
    const session = {
        id,
        repository: repo.root,
        projectName: repo.projectName,
        baseBranch: repo.branch,
        baseCommit: repo.headCommit,
        task: opts.task.trim(),
        taskMode,
        originalTask,
        status: "created",
        players: [],
        verify,
        setup,
        arenaDir: dir,
        startedAt: new Date().toISOString(),
        selected: null,
        reviews: [],
    };
    // 1. isolate
    for (let i = 0; i < runners.length; i++) {
        const runner = runners[i];
        const playerId = playerIds[i];
        const branch = `arena/${id}/${playerId}`;
        const worktree = join(dir, playerId);
        log(`creating worktree ${worktree} (branch ${branch})`);
        createWorktree(repo.root, worktree, branch, repo.headCommit);
        session.players.push({
            id: playerId,
            runner: runner.id,
            label: runners.length > 1 && playerIds.filter((p) => p.startsWith(runner.id)).length > 1 ? `${runner.label} #${i + 1}` : runner.label,
            branch,
            worktree,
            status: "pending",
            promptPath: join(dir, `${playerId}.prompt.md`),
            stdoutPath: join(logsDir, `${playerId}.stdout.log`),
            stderrPath: join(logsDir, `${playerId}.stderr.log`),
            exitCodePath: join(logsDir, `${playerId}.exit`),
            asks: [],
        });
    }
    saveSession(session);
    // 2. prepare: install dependencies etc. so runners and verification see a usable checkout
    if (setup.length > 0) {
        log(`running setup in each worktree: ${setup.join(" && ")}`);
        const timeout = opts.setupTimeoutMs ?? (config.verify.timeout ? config.verify.timeout * 1000 : DEFAULT_VERIFY_TIMEOUT_MS);
        const results = await Promise.all(session.players.map(async (player) => {
            const logPath = join(logsDir, `${player.id}.setup.log`);
            const started = Date.now();
            let passed = true;
            for (const command of setup) {
                const r = await runVerification(command, player.worktree, logPath, timeout, { append: true });
                if (!r.passed) {
                    passed = false;
                    break;
                }
            }
            player.setup = { commands: setup, passed, durationMs: Date.now() - started, logPath };
            return player;
        }));
        saveSession(session);
        const failed = results.filter((p) => !p.setup?.passed);
        if (failed.length > 0) {
            for (const p of session.players) {
                try {
                    removeWorktree(repo.root, p.worktree);
                    deleteBranch(repo.root, p.branch);
                }
                catch {
                    /* best effort */
                }
            }
            session.status = "cleaned";
            saveSession(session);
            throw new Error(`setup failed for ${failed.map((p) => p.label).join(", ")} (see ${failed.map((p) => p.setup?.logPath).join(", ")}). ` +
                `Fix the setup command, set "setup: false" in .arena.yaml, or pass --no-setup.`);
        }
        log(`setup done (${results.map((p) => `${p.label} ${Math.round((p.setup?.durationMs ?? 0) / 1000)}s`).join(", ")})`);
    }
    // 3. run — runners receive only `task`; in refined mode the original request stays with the session
    const prompt = buildArenaPrompt(session.task, { refined: taskMode === "refined" });
    for (let i = 0; i < runners.length; i++) {
        const runner = runners[i];
        const player = session.players[i];
        writeFileSync(player.promptPath, prompt);
        const invocation = runner.invocation({
            prompt,
            task: session.task,
            cwd: player.worktree,
            branch: player.branch,
            arenaId: id,
            promptPath: player.promptPath,
            resultsDir,
        });
        const pid = spawnDetached({
            command: invocation.command,
            args: invocation.args,
            cwd: player.worktree,
            env: { ...(invocation.env ?? {}), ARENA_ID: id, ARENA_PLAYER: player.id, ARENA_WORKTREE: player.worktree },
            promptPath: player.promptPath,
            promptViaStdin: invocation.promptViaStdin,
            stdoutPath: player.stdoutPath,
            stderrPath: player.stderrPath,
            exitCodePath: player.exitCodePath,
            specPath: join(logsDir, `${player.id}.spec.json`),
        });
        player.pid = pid;
        player.status = "running";
        player.startedAt = new Date().toISOString();
        player.command = [invocation.command, ...invocation.args].join(" ");
        player.runnerSession = invocation.sessionId;
        log(`started ${player.label} (pid ${pid})`);
    }
    session.status = "running";
    saveSession(session);
    return session;
}
/** Re-read exit files / pids and update player + session status. Persists changes. */
export function refreshSession(id) {
    const session = loadSession(id);
    let changed = false;
    for (const p of session.players) {
        if (p.status !== "running")
            continue;
        const code = readExitCode(p.exitCodePath);
        if (code !== null) {
            p.exitCode = code;
            p.status = code === 0 ? "completed" : "failed";
            p.finishedAt = p.finishedAt ?? new Date().toISOString();
            changed = true;
        }
        else if (p.pid !== undefined && !isProcessAlive(p.pid)) {
            p.exitCode = null;
            p.status = "failed";
            p.finishedAt = new Date().toISOString();
            changed = true;
        }
    }
    if (session.status === "running" && session.players.every((p) => p.status !== "running" && p.status !== "pending")) {
        session.status = "finished";
        session.finishedAt = new Date().toISOString();
        changed = true;
    }
    if (changed)
        saveSession(session);
    return session;
}
export function isSessionActive(session) {
    return session.players.some((p) => p.status === "running" || p.status === "pending");
}
/** Poll until every player finished (or timeout / abort). */
export async function waitForArena(id, opts = {}) {
    const interval = opts.intervalMs ?? 2000;
    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : Infinity;
    let session = refreshSession(id);
    while (isSessionActive(session)) {
        if (opts.signal?.aborted)
            break;
        if (Date.now() > deadline)
            throw new Error(`Timed out waiting for arena ${id}`);
        opts.onTick?.(session);
        await new Promise((r) => setTimeout(r, interval));
        session = refreshSession(id);
    }
    opts.onTick?.(session);
    return session;
}
export function stopArena(id) {
    const session = refreshSession(id);
    for (const p of session.players) {
        if (p.status !== "running" || p.pid === undefined)
            continue;
        killProcessGroup(p.pid, "SIGTERM");
        p.status = "stopped";
        p.finishedAt = new Date().toISOString();
    }
    session.status = "stopped";
    session.finishedAt = session.finishedAt ?? new Date().toISOString();
    saveSession(session);
    // Escalate for anything that ignored SIGTERM.
    setTimeout(() => {
        for (const p of session.players) {
            if (p.pid !== undefined && isProcessAlive(p.pid))
                killProcessGroup(p.pid, "SIGKILL");
        }
    }, 3000).unref();
    return session;
}
/** Gather diff stats and run verification for finished players. */
export async function collectResults(id, opts = {}) {
    const log = opts.log ?? (() => { });
    const session = refreshSession(id);
    if (opts.verify) {
        const config = loadConfig(session.repository);
        session.verify = resolveVerifyCommands(session.repository, config.verify, opts.verify);
    }
    const resultsDir = join(session.arenaDir, "results");
    mkdirSync(resultsDir, { recursive: true });
    const configTimeoutSec = loadConfig(session.repository).verify.timeout;
    const effectiveTimeout = opts.timeoutMs ?? (configTimeoutSec ? configTimeoutSec * 1000 : DEFAULT_VERIFY_TIMEOUT_MS);
    const targets = opts.players?.length ? opts.players.map((p) => findPlayer(session, p)) : session.players;
    for (const p of targets) {
        if (p.status === "running" || p.status === "pending") {
            log(`skipping ${p.label}: still ${p.status}`);
            continue;
        }
        if (!existsSync(p.worktree)) {
            log(`skipping ${p.label}: worktree missing`);
            continue;
        }
        log(`collecting ${p.label}`);
        const diffPath = join(resultsDir, `${p.id}.diff`);
        const statusPath = join(resultsDir, `${p.id}.status.txt`);
        const stats = collectDiff(p.worktree, session.baseCommit, diffPath, statusPath);
        const verification = opts.skipVerification
            ? {}
            : await runAllVerifications(session.verify, p.worktree, (kind) => join(resultsDir, `${p.id}.${kind}.log`), effectiveTimeout, (kind, cmd) => log(`  ${p.label}: ${kind} → ${cmd}`));
        const started = p.startedAt ? Date.parse(p.startedAt) : Date.now();
        const finished = p.finishedAt ? Date.parse(p.finishedAt) : Date.now();
        p.result = {
            runnerId: p.runner,
            durationMs: Math.max(0, finished - started),
            git: { ...stats, diffPath, statusPath },
            verification,
            collectedAt: new Date().toISOString(),
        };
        saveSession(session);
    }
    if (session.players.every((p) => p.result || p.status === "running" || p.status === "pending") && !isSessionActive(session)) {
        session.status = "collected";
    }
    saveSession(session);
    return session;
}
export const DEFAULT_ASK_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
/**
 * Check that a finished runner's conversation can be resumed and make sure its conversation id is
 * known (looked up now for runners that only reveal it after the run, e.g. Codex). Saves the session
 * when an id was discovered.
 */
function prepareResume(session, player, log) {
    if (player.status === "running" || player.status === "pending") {
        throw new Error(`${player.label} is still ${player.status}; wait for it to finish before asking (arena wait ${session.id})`);
    }
    if (!existsSync(player.worktree))
        throw new Error(`Worktree missing for ${player.id}: ${player.worktree} (a cleaned arena cannot be asked)`);
    const config = loadConfig(session.repository);
    const runner = resolveRunner(createRunnerRegistry(config), player.runner);
    if (!runner.askInvocation) {
        throw new Error(`Runner "${runner.id}" cannot resume its conversation. Built-in runners support arena ask; custom runners need "askArgs" in .arena.yaml.`);
    }
    const resultsDir = join(session.arenaDir, "results");
    const logsDir = join(session.arenaDir, "logs");
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    // The conversation id was either fixed at launch (Claude) or has to be looked up now (Codex).
    if (!player.runnerSession && runner.findSessionId) {
        const found = runner.findSessionId({
            cwd: player.worktree,
            startedAt: player.startedAt ?? session.startedAt,
            stdoutPath: player.stdoutPath,
            stderrPath: player.stderrPath,
            resultsDir,
        });
        if (found) {
            player.runnerSession = found;
            saveSession(session);
            log(`found ${player.label} conversation ${found}`);
        }
    }
    if (!player.runnerSession && (runner.findSessionId || runner.id === "claude")) {
        throw new Error(`No conversation id known for ${player.label}. The runner's session store has no thread for ${player.worktree}` +
            ` (sessions started before arena ask existed cannot be resumed).`);
    }
    return { runner, resultsDir, logsDir };
}
/**
 * Resume the runner's conversation inside its worktree with a read-only prompt and wait for the
 * answer. The worktree is fingerprinted before and after so an answer that (against instructions)
 * changed files is flagged: results collected earlier would then be stale.
 */
async function resumeConversation(session, player, ctx, x) {
    const stem = `${player.id}.${x.kind}-${x.n}`;
    const promptPath = join(session.arenaDir, `${stem}.prompt.md`);
    const answerPath = join(ctx.resultsDir, `${stem}.md`);
    const stderrPath = join(ctx.logsDir, `${stem}.stderr.log`);
    writeFileSync(promptPath, x.prompt);
    const invocation = ctx.runner.askInvocation({ sessionId: player.runnerSession ?? "", prompt: x.prompt, promptPath, cwd: player.worktree, resultsDir: ctx.resultsDir });
    const scratchIndex = join(ctx.logsDir, `${player.id}.${x.kind}.index`);
    const before = worktreeFingerprint(player.worktree, scratchIndex);
    const askedAt = new Date().toISOString();
    x.log(`${x.kind === "ask" ? "asking" : "review by"} ${player.label}: ${invocation.command} ${invocation.args.join(" ")}`);
    const r = await runForeground({
        command: invocation.command,
        args: invocation.args,
        cwd: player.worktree,
        env: { ...(invocation.env ?? {}), ARENA_ID: session.id, ARENA_PLAYER: player.id, ARENA_WORKTREE: player.worktree },
        promptPath,
        promptViaStdin: invocation.promptViaStdin,
        stdoutPath: answerPath,
        stderrPath,
        timeoutMs: x.timeoutMs,
    });
    const worktreeChanged = worktreeFingerprint(player.worktree, scratchIndex) !== before;
    const answer = existsSync(answerPath) ? readFileSync(answerPath, "utf8") : "";
    return { askedAt, durationMs: r.durationMs, exitCode: r.exitCode, promptPath, answerPath, stderrPath, timedOut: r.timedOut, worktreeChanged, answer };
}
/**
 * Put a read-only follow-up question to a finished runner by resuming its own conversation inside
 * its worktree. The runner keeps the context of its implementation; the core keeps the answer.
 */
export async function askPlayer(id, playerRef, question, opts = {}) {
    const log = opts.log ?? (() => { });
    if (!question.trim())
        throw new Error("Question must not be empty");
    const session = refreshSession(id);
    const player = findPlayer(session, playerRef);
    const ctx = prepareResume(session, player, log);
    const n = player.asks.length + 1;
    const r = await resumeConversation(session, player, ctx, { kind: "ask", n, prompt: buildAskPrompt(question), timeoutMs: opts.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS, log });
    const ask = {
        n,
        question: question.trim(),
        askedAt: r.askedAt,
        durationMs: r.durationMs,
        exitCode: r.exitCode,
        promptPath: r.promptPath,
        answerPath: r.answerPath,
        stderrPath: r.stderrPath,
        timedOut: r.timedOut,
        worktreeChanged: r.worktreeChanged,
    };
    // Re-read before recording: another `arena ask` (or a collect) may have saved the session meanwhile.
    const latest = refreshSession(id);
    const target = findPlayer(latest, player.id);
    target.runnerSession = target.runnerSession ?? player.runnerSession;
    target.asks.push(ask);
    saveSession(latest);
    return { session: latest, player: target, ask, answer: r.answer };
}
export const DEFAULT_REVIEW_DIFF_BYTES = 150_000;
/** Parse the `VERDICT:` line a reviewer was asked to start with. */
export function parseReviewVerdict(answer) {
    const m = /^\s*(?:[*_#]+\s*)?VERDICT\s*(?:[*_]+)?\s*:\s*(?:[*_`]+\s*)?(approve|request[-_ ]changes)/im.exec(answer);
    if (!m)
        return "unknown";
    return m[1].toLowerCase().startsWith("approve") ? "approve" : "request-changes";
}
/**
 * Have every runner review the final version (the selected candidate's worktree: a synthesis or a
 * candidate adopted as is) by resuming their conversations read-only, in parallel. Each runner sees
 * the same diff (base commit → final working tree) and answers in a fixed format whose first line
 * is the verdict. Runners that cannot be resumed are recorded with an error instead of failing the
 * whole round.
 */
export async function reviewFinal(id, opts = {}) {
    const log = opts.log ?? (() => { });
    const session = refreshSession(id);
    if (!session.selected)
        throw new Error(`No candidate selected for ${id}: select or synthesize first (arena select ${id} <player> / arena synthesize ${id} <base>)`);
    const target = findPlayer(session, session.selected);
    if (!existsSync(target.worktree))
        throw new Error(`Worktree missing for ${target.id}: ${target.worktree}`);
    const reviewers = (opts.players?.length ? opts.players.map((ref) => findPlayer(session, ref)) : session.players).filter((p, i, all) => all.indexOf(p) === i);
    if (!reviewers.length)
        throw new Error("No reviewers");
    const n = session.reviews.length + 1;
    const resultsDir = join(session.arenaDir, "results");
    const logsDir = join(session.arenaDir, "logs");
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    const diffPath = join(resultsDir, `final.review-${n}.diff`);
    collectDiff(target.worktree, session.baseCommit, diffPath, join(logsDir, `final.review-${n}.status`));
    const diff = readFileSync(diffPath, "utf8");
    const maxDiffBytes = opts.maxDiffBytes ?? DEFAULT_REVIEW_DIFF_BYTES;
    const inline = diff.length > maxDiffBytes ? "" : diff;
    const targetHead = gitTry(target.worktree, ["rev-parse", "HEAD"]);
    const targetFingerprint = worktreeFingerprint(target.worktree, join(logsDir, "final.review.index"));
    const synthesized = session.synthesis !== undefined;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
    // Resolve conversation ids sequentially (this may save the session), then review in parallel.
    const prepared = reviewers.map((player) => {
        try {
            return { player, ctx: prepareResume(session, player, log), error: undefined };
        }
        catch (err) {
            log(`skipping ${player.label}: ${err.message}`);
            return { player, ctx: undefined, error: err.message };
        }
    });
    const requestedAt = new Date().toISOString();
    const results = await Promise.all(prepared.map(async ({ player, ctx, error }) => {
        if (!ctx) {
            return { entry: { player: player.id, verdict: "unknown", askedAt: requestedAt, durationMs: 0, exitCode: null, timedOut: false, worktreeChanged: false, error }, answer: "" };
        }
        const prompt = buildReviewPrompt({
            finalLabel: target.label,
            finalWorktree: target.worktree,
            finalBranch: target.branch,
            reviewerIsTarget: player.id === target.id,
            reviewerWorktree: player.worktree,
            synthesized,
            baseCommit: session.baseCommit,
            diff: inline,
            diffPath,
            diffTruncated: false,
            instructions: opts.instructions,
        });
        const r = await resumeConversation(session, player, ctx, { kind: "review", n, prompt, timeoutMs, log });
        const entry = {
            player: player.id,
            verdict: r.timedOut ? "unknown" : parseReviewVerdict(r.answer),
            askedAt: r.askedAt,
            durationMs: r.durationMs,
            exitCode: r.exitCode,
            promptPath: r.promptPath,
            answerPath: r.answerPath,
            stderrPath: r.stderrPath,
            timedOut: r.timedOut,
            worktreeChanged: r.worktreeChanged,
        };
        return { entry, answer: r.answer };
    }));
    const round = {
        n,
        target: target.id,
        targetCommit: targetHead.exitCode === 0 ? targetHead.stdout.trim() : null,
        targetFingerprint,
        requestedAt,
        diffPath,
        instructions: opts.instructions?.trim() || undefined,
        entries: results.map((r) => r.entry),
    };
    const latest = refreshSession(id);
    for (const { player } of prepared) {
        const p = findPlayer(latest, player.id);
        p.runnerSession = p.runnerSession ?? player.runnerSession;
    }
    latest.reviews.push(round);
    saveSession(latest);
    const answers = {};
    for (const [i, r] of results.entries())
        answers[reviewers[i].id] = r.answer;
    return { session: latest, round, answers };
}
/**
 * Content fingerprint of a worktree: HEAD plus a tree object built from the full working tree
 * (tracked, modified and untracked files alike) through a scratch index, so the real index and the
 * runner's own state stay untouched.
 */
function worktreeFingerprint(worktree, scratchIndex) {
    const env = { ...process.env, GIT_INDEX_FILE: scratchIndex };
    try {
        const head = git(worktree, ["rev-parse", "HEAD"]).trim();
        git(worktree, ["read-tree", "HEAD"], { env });
        git(worktree, ["add", "--all", "--force"], { env });
        const tree = git(worktree, ["write-tree"], { env }).trim();
        return `${head}:${tree}`;
    }
    catch {
        // Fall back to a coarse status-based fingerprint (e.g. an unborn HEAD).
        const parts = [gitTry(worktree, ["status", "--porcelain", "--untracked-files=all"]).stdout, gitTry(worktree, ["diff", "HEAD"]).stdout];
        return createHash("sha1").update(parts.join("\u0000")).digest("hex");
    }
    finally {
        rmSync(scratchIndex, { force: true });
    }
}
export function selectCandidate(id, playerRef) {
    const session = refreshSession(id);
    session.selected = playerRef === null ? null : findPlayer(session, playerRef).id;
    saveSession(session);
    return session;
}
/**
 * `-c` options giving git an author when none is configured (headless hosts, CI). The user's own
 * identity is used whenever it exists; the placeholder never leaks a real address.
 */
function commitIdentity(worktree) {
    const name = gitTry(worktree, ["config", "user.name"]).stdout.trim();
    const email = gitTry(worktree, ["config", "user.email"]).stdout.trim();
    if (name && email)
        return [];
    return ["-c", `user.name=${name || "Arena"}`, "-c", `user.email=${email || "arena@localhost"}`];
}
/** Commit whatever is in the candidate worktree onto its branch so the branch is self-contained. */
export function commitCandidate(id, playerRef, message) {
    const session = refreshSession(id);
    const player = findPlayer(session, playerRef);
    if (!existsSync(player.worktree))
        throw new Error(`Worktree missing for ${player.id}: ${player.worktree}`);
    git(player.worktree, ["add", "--all"]);
    const staged = gitTry(player.worktree, ["diff", "--cached", "--quiet"]);
    if (staged.exitCode === 0) {
        return { player, committed: false, commit: gitTry(player.worktree, ["rev-parse", "HEAD"]).stdout.trim() || null };
    }
    git(player.worktree, [...commitIdentity(player.worktree), "commit", "--quiet", "--no-verify", "-m", message ?? `arena(${session.id}): ${player.label} candidate\n\nTask: ${session.task.split("\n")[0]}`]);
    return { player, committed: true, commit: git(player.worktree, ["rev-parse", "HEAD"]).trim() };
}
/**
 * Begin the finishing pass on the winning candidate: select it, snapshot its worktree onto its
 * branch (so the host's later edits are a separate commit), and record the synthesis in the session.
 * The host then edits inside `base.worktree`, re-collects, and commits with `commitCandidate`.
 */
export function startSynthesis(id, baseRef) {
    let session = refreshSession(id);
    const base = findPlayer(session, baseRef);
    if (base.status === "running" || base.status === "pending")
        throw new Error(`${base.label} is still ${base.status}`);
    if (!existsSync(base.worktree))
        throw new Error(`Worktree missing for ${base.id}: ${base.worktree}`);
    const snapshot = commitCandidate(id, base.id, `arena(${session.id}): ${base.label} candidate (snapshot before synthesis)`);
    session = selectCandidate(id, base.id);
    session.synthesis = {
        base: base.id,
        startedAt: new Date().toISOString(),
        snapshotCommit: snapshot.commit,
    };
    saveSession(session);
    return { session, base: findPlayer(session, base.id), others: session.players.filter((p) => p.id !== base.id) };
}
/** Mark the synthesis finished (after the host committed its work with `commitCandidate`). */
export function finishSynthesis(id) {
    const session = refreshSession(id);
    if (!session.synthesis)
        throw new Error(`No synthesis in progress for ${id}`);
    const base = findPlayer(session, session.synthesis.base);
    const head = gitTry(base.worktree, ["rev-parse", "HEAD"]);
    session.synthesis.finishedAt = new Date().toISOString();
    session.synthesis.commit = head.exitCode === 0 ? head.stdout.trim() : undefined;
    saveSession(session);
    return session;
}
/**
 * Merge the selected candidate's branch into the repository's current branch.
 * Refuses on a dirty working tree, when nothing is selected, or when HEAD is not the session's base branch.
 * Never pushes.
 */
export function adoptCandidate(id, opts = {}) {
    const session = refreshSession(id);
    if (!session.selected)
        throw new Error(`No candidate selected for ${id}. Run: arena select ${id} <player>`);
    const player = findPlayer(session, session.selected);
    const repo = inspectRepository(session.repository);
    if (repo.dirty)
        throw new Error(`Repository has uncommitted changes; commit or stash them before adopting`);
    if (session.baseBranch && repo.branch !== session.baseBranch) {
        throw new Error(`Repository is on "${repo.branch ?? "(detached)"}" but the arena started from "${session.baseBranch}". Check out ${session.baseBranch} first.`);
    }
    if (existsSync(player.worktree)) {
        const pending = gitTry(player.worktree, ["status", "--porcelain"]);
        if (pending.stdout.trim())
            throw new Error(`${player.label} worktree has uncommitted changes. Run: arena commit ${id} ${player.id}`);
    }
    const mode = opts.mode ?? "merge";
    const message = opts.message ?? `arena(${session.id}): adopt ${player.label}

Task: ${session.task.split("\n")[0]}`;
    if (mode === "squash") {
        git(repo.root, ["merge", "--squash", player.branch]);
        git(repo.root, ["commit", "--quiet", "--no-verify", "-m", message]);
    }
    else if (mode === "ff") {
        git(repo.root, ["merge", "--ff-only", player.branch]);
    }
    else {
        git(repo.root, ["merge", "--no-ff", "--no-edit", "-m", message, player.branch]);
    }
    const commit = git(repo.root, ["rev-parse", "HEAD"]).trim();
    session.adopted = { player: player.id, mode, commit, at: new Date().toISOString() };
    saveSession(session);
    return { session, player, commit, mode };
}
export function cleanArena(id, opts = {}) {
    const log = opts.log ?? (() => { });
    const session = refreshSession(id);
    if (isSessionActive(session)) {
        stopArena(id);
    }
    for (const p of session.players) {
        if (existsSync(p.worktree)) {
            log(`removing worktree ${p.worktree}`);
            try {
                removeWorktree(session.repository, p.worktree);
            }
            catch (err) {
                log(`  failed: ${err.message}`);
            }
        }
        const keep = session.selected === p.id && !opts.force;
        if ((opts.deleteBranches ?? true) && !keep) {
            if (deleteBranch(session.repository, p.branch))
                log(`deleted branch ${p.branch}`);
        }
        else if (keep) {
            log(`kept branch ${p.branch} (selected)`);
        }
    }
    if (opts.force && existsSync(session.arenaDir)) {
        rmSync(session.arenaDir, { recursive: true, force: true });
        log(`removed ${session.arenaDir}`);
    }
    session.status = "cleaned";
    saveSession(session);
    return session;
}
