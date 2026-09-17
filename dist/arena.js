#!/usr/bin/env node
/**
 * Arena CLI — thin, non-interactive command surface over Arena Core.
 * Hosts (the Claude Code /arena skill, other harnesses, humans) drive it with subcommands.
 */
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { adoptCandidate, askPlayer, checkRunners, cleanArena, finishSynthesis, startSynthesis, collectResults, commitCandidate, isSessionActive, refreshSession, reviewFinal, selectCandidate, startArena, stopArena, waitForArena, } from "./core.js";
import { renderCompareBundle, renderReviewReport, renderStatus, renderSummary, renderSynthesisBrief, formatDuration, playerDurationMs } from "./compare/summary.js";
import { findPlayer, listSessions, resolveSessionId } from "./session.js";
import { inspectRepository } from "./git/repository.js";
import { resolveSetupCommands, resolveVerifyCommands } from "./verification/detect.js";
import { loadConfig } from "./config.js";
import { sessionFile } from "./paths.js";
import { installSkill } from "./install.js";
import { buildRefineContext, defaultTaskMode, renderRefineBrief } from "./refine.js";
import { describeHost, detectHost } from "./host.js";
import { createIntegrations, integrationStatuses, syncIntegrations } from "./integrations/index.js";
const HELP = `arena — run coding agents on the same task in isolated git worktrees and compare.

Usage:
  arena install-skill [--force] [--config-dir <path>]
                                                    Install the Claude Code /arena skill (no repository required)
  arena doctor [--repo <path>]                      Check runner availability, detected verify commands and the task mode default
  arena refine --task <text>|--task-file <f> [--repo <path>] [--no-draft] [--json]
                                                    Print the refinement brief: repository facts, procedure and specification
                                                    template for turning the request into a one-shot task (host does the asking)
  arena start --task <text>|--task-file <f> [--players claude,codex] [--repo <path>] [--setup <cmd>|--no-setup]
              [--original-task <text>|--original-task-file <f>]
                                                    Create session + worktrees, run setup (e.g. npm ci), launch runners.
                                                    With --original-task* the task is a refined specification (refined mode);
                                                    without it the task goes to the runners verbatim (simple mode)
  arena status <id|latest> [--json]                 Show runner progress
  arena wait <id|latest> [--timeout <sec>] [--json] Block until every runner finishes
  arena stop <id|latest>                            Terminate running runners
  arena collect <id|latest> [--no-verify] [--player <p>] [--test <cmd>] [--lint <cmd>] [--typecheck <cmd>]
                                                    Collect diff stats and run test/lint/typecheck per candidate
  arena summary <id|latest> [--json]                Print the comparison table
  arena compare <id|latest> [--max-diff-bytes <n>]  Print the markdown review bundle for an LLM/human reviewer
  arena diff <id|latest> <player>                   Print a candidate's diff
  arena logs <id|latest> <player> [--stderr]        Print a runner's output log
  arena ask <id|latest> <player> [question] [--question-file <f>] [--timeout <sec>] [--json]
                                                    Resume the finished runner's own conversation inside its worktree with a
                                                    read-only question (Claude session / Codex thread) and print its answer
  arena review <id|latest> [--players a,b] [--instructions <text>|--instructions-file <f>] [--timeout <sec>] [--json]
                                                    Have every runner review the final version (the selected candidate's
                                                    worktree) by resuming its conversation read-only; prints the verdicts
  arena select <id|latest> <player|none>            Record the adopted candidate and print its branch
  arena commit <id|latest> <player> [-m <msg>]      Commit the candidate worktree onto its branch
  arena synthesize <id|latest> <winner>             Start the finishing pass: snapshot + select the winner, print a brief
                                                    with the other candidates' diffs (host edits the winner's worktree)
  arena finish <id|latest>                          Record the synthesis as finished (after arena commit)
  arena adopt <id|latest> [--ff|--squash] [-m <msg>] Merge the selected branch into the current (base) branch. Never pushes.
  arena run --task <text> [--players ...]           start + wait + collect + summary (foreground, Ctrl+C stops runners)
  arena open <id|latest> [player]                   Show a candidate's changed files in the workspace app (Orca); default: the
                                                    selected candidate, else every candidate
  arena list [--json]                               List sessions
  arena inspect <id|latest>                         Print the session JSON
  arena clean <id|latest> [--keep-branches] [--force]
                                                    Remove worktrees (and branches); --force also deletes logs/session dir

Common options:
  --original-task <text> / --original-task-file <f>
                                         The user's request as typed, recorded next to the refined task (refined mode)
  --test/--lint/--typecheck <cmd|false>  Override verification commands (false disables)
  --setup <cmd> / --no-setup             Worktree preparation command (default: .arena.yaml setup or lockfile detection)
  --json                                 Machine-readable output
  --repo <path>                          Repository (default: cwd)
`;
function fail(msg, code = 1) {
    process.stderr.write(`error: ${msg}\n`);
    process.exit(code);
}
function print(s) {
    process.stdout.write(s.endsWith("\n") ? s : s + "\n");
}
function verifyOverridesFrom(values) {
    const out = {};
    for (const k of ["test", "lint", "typecheck"]) {
        const v = values[k];
        if (typeof v === "string")
            out[k] = v === "false" || v === "" ? false : v;
    }
    return Object.keys(out).length ? out : undefined;
}
function readTask(values, positionals) {
    if (values["task-file"]) {
        const p = resolve(values["task-file"]);
        if (!existsSync(p))
            fail(`task file not found: ${p}`);
        return readFileSync(p, "utf8");
    }
    if (values.task)
        return values.task;
    if (positionals.length)
        return positionals.join(" ");
    if (!process.stdin.isTTY) {
        const buf = readFileSync(0, "utf8");
        if (buf.trim())
            return buf;
    }
    return fail("task is required (--task, --task-file, positional text, or stdin)");
}
/** The user's request as typed (refined mode). Undefined means simple mode. */
function readOriginalTask(values) {
    if (values["original-task"] && values["original-task-file"])
        fail("use either --original-task or --original-task-file, not both");
    if (values["original-task-file"]) {
        const p = resolve(values["original-task-file"]);
        if (!existsSync(p))
            fail(`original task file not found: ${p}`);
        const text = readFileSync(p, "utf8");
        if (!text.trim())
            fail(`original task file is empty: ${p}`);
        return text;
    }
    if (values["original-task"] !== undefined) {
        if (!values["original-task"].trim())
            fail("--original-task must not be empty");
        return values["original-task"];
    }
    return undefined;
}
function parsePlayers(v) {
    return (v ?? "claude,codex")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
function sessionArg(positionals, index = 0) {
    const ref = positionals[index];
    if (!ref)
        fail("session id required (or 'latest')");
    return resolveSessionId(ref);
}
function jsonOut(session) {
    print(JSON.stringify(session, null, 2));
}
/** Mirror the session into active workspace apps (Orca). Display-only and best effort: never fails a command. */
async function mirror(session, retries = 0) {
    try {
        await syncIntegrations(session, loadConfig(session.repository), { retries, log: (l) => process.stderr.write(`${l}\n`) });
    }
    catch (err) {
        process.stderr.write(`warning: workspace integrations skipped: ${err.message}\n`);
    }
}
function cmdInstallSkill(argv) {
    const { values } = parseArgs({
        args: argv,
        options: { force: { type: "boolean" }, "config-dir": { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
        print("Usage: arena install-skill [--force] [--config-dir <path>]\n\nCopies the bundled /arena skill to <config-dir>/skills/arena/SKILL.md.\nDefault: CLAUDE_CONFIG_DIR or ~/.claude. Existing custom skills require --force.");
        return;
    }
    const result = installSkill({ configDir: values["config-dir"], force: values.force });
    print(`${result.changed ? "Installed" : "Already installed"}: ${result.path}\nRestart Claude Code to use /arena.`);
}
async function cmdDoctor(argv) {
    const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, json: { type: "boolean" } } });
    const repoPath = resolve(values.repo ?? process.cwd());
    let repoInfo = null;
    let repoError = null;
    try {
        repoInfo = inspectRepository(repoPath);
    }
    catch (err) {
        repoError = err.message;
    }
    const root = repoInfo?.root ?? repoPath;
    const runners = await checkRunners(root);
    const verify = repoInfo ? resolveVerifyCommands(root, loadConfig(root).verify) : {};
    const setup = repoInfo ? resolveSetupCommands(root, loadConfig(root).setup, undefined) : [];
    const taskMode = defaultTaskMode(root);
    const host = detectHost(root);
    const integrations = integrationStatuses(loadConfig(root));
    if (values.json) {
        print(JSON.stringify({ repository: repoInfo, repositoryError: repoError, runners, verify, setup, taskMode, refine: taskMode === "refined", host, integrations }, null, 2));
        return;
    }
    print("Arena doctor");
    print("");
    if (repoInfo) {
        print(`repository   ${repoInfo.root}`);
        print(`branch       ${repoInfo.branch ?? "(detached)"} @ ${repoInfo.headCommit.slice(0, 12)}${repoInfo.dirty ? "  (uncommitted changes)" : ""}`);
    }
    else {
        print(`repository   ${repoError}`);
    }
    print("");
    print("runners");
    for (const r of runners)
        print(`  ${r.id.padEnd(10)} ${r.available ? "✓" : "✗"} ${r.command}${r.available ? "" : "  (not found in PATH)"}`);
    print("");
    print("verification");
    for (const k of ["test", "lint", "typecheck"])
        print(`  ${k.padEnd(10)} ${verify[k] ?? "(none)"}`);
    print("");
    print("worktree setup");
    print(`  ${setup.length ? setup.join(" && ") : "(none)"}`);
    print("");
    print("task mode");
    print(`  ${taskMode === "refined" ? "refined (host clarifies the request before launching; use simple mode to skip)" : "simple (config refine: false; request is passed verbatim)"}`);
    print("");
    print("host");
    for (const line of describeHost(host))
        print(`  ${line}`);
    print("");
    print("workspace apps");
    for (const i of integrations)
        print(`  ${i.id.padEnd(10)} ${i.active ? "✓" : "–"} ${i.detail}`);
    const missing = runners.filter((r) => !r.available && (r.id === "claude" || r.id === "codex"));
    if (missing.length)
        process.exitCode = 1;
}
function cmdRefine(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            task: { type: "string", short: "t" },
            "task-file": { type: "string" },
            repo: { type: "string" },
            "no-draft": { type: "boolean" },
            json: { type: "boolean" },
        },
    });
    const task = readTask(values, positionals);
    const ctx = buildRefineContext({ repo: resolve(values.repo ?? process.cwd()), task, saveDraft: !values["no-draft"] });
    if (values.json)
        print(JSON.stringify(ctx, null, 2));
    else
        print(renderRefineBrief(ctx));
}
async function cmdStart(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            task: { type: "string", short: "t" },
            "task-file": { type: "string" },
            "original-task": { type: "string" },
            "original-task-file": { type: "string" },
            players: { type: "string", short: "p" },
            repo: { type: "string" },
            test: { type: "string" },
            lint: { type: "string" },
            typecheck: { type: "string" },
            setup: { type: "string", multiple: true },
            "no-setup": { type: "boolean" },
            json: { type: "boolean" },
        },
    });
    const task = readTask(values, positionals);
    const originalTask = readOriginalTask(values);
    const session = await startArena({
        repo: resolve(values.repo ?? process.cwd()),
        task,
        originalTask,
        players: parsePlayers(values.players),
        verify: verifyOverridesFrom(values),
        setup: values["no-setup"] ? false : values.setup,
        log: (l) => process.stderr.write(`${l}\n`),
    });
    await mirror(session, 3); // Orca needs a moment to discover the new worktrees
    if (values.json) {
        jsonOut(session);
    }
    else {
        print(`Arena ${session.id} started`);
        print(`base     ${session.baseCommit.slice(0, 12)}${session.baseBranch ? ` (${session.baseBranch})` : ""}`);
        print(`task     ${session.taskMode === "refined" ? "refined specification (original request recorded)" : "simple mode (request passed verbatim)"}`);
        for (const p of session.players)
            print(`${p.label.padEnd(8)} ${p.branch}  ${p.worktree}`);
        print(`\nNext: arena wait ${session.id}`);
    }
    return session;
}
function cmdStatus(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } });
    const session = refreshSession(sessionArg(positionals));
    if (values.json)
        jsonOut(session);
    else
        print(renderStatus(session));
}
async function cmdWait(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { json: { type: "boolean" }, timeout: { type: "string" }, interval: { type: "string" }, quiet: { type: "boolean" } },
    });
    const id = sessionArg(positionals);
    const session = await waitProgress(id, values.timeout ? Number(values.timeout) * 1000 : undefined, values.quiet ? undefined : (values.interval ? Number(values.interval) : 30) * 1000, false);
    await mirror(session);
    if (values.json)
        jsonOut(session);
    else
        print(renderStatus(session));
}
/** Wait, printing a progress line every `progressEveryMs` (stderr) so long waits stay observable. */
async function waitProgress(id, timeoutMs, progressEveryMs, stopOnSigint) {
    const controller = new AbortController();
    let interrupted = false;
    const onSigint = () => {
        interrupted = true;
        controller.abort();
    };
    if (stopOnSigint)
        process.on("SIGINT", onSigint);
    let lastPrint = 0;
    const session = await waitForArena(id, {
        timeoutMs,
        signal: controller.signal,
        onTick: (s) => {
            const now = Date.now();
            if (progressEveryMs && (now - lastPrint >= progressEveryMs || !isSessionActive(s))) {
                lastPrint = now;
                const line = s.players.map((p) => `${p.label} ${p.status} ${formatDuration(playerDurationMs(p, now))}`).join(" | ");
                process.stderr.write(`[arena ${s.id}] ${line}\n`);
            }
        },
    });
    if (stopOnSigint)
        process.off("SIGINT", onSigint);
    if (interrupted) {
        process.stderr.write("\nstopping runners...\n");
        return stopArena(id);
    }
    return session;
}
async function cmdStop(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } });
    const session = stopArena(sessionArg(positionals));
    await mirror(session);
    if (values.json)
        jsonOut(session);
    else
        print(renderStatus(session));
}
async function cmdCollect(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            json: { type: "boolean" },
            "no-verify": { type: "boolean" },
            player: { type: "string", multiple: true },
            test: { type: "string" },
            lint: { type: "string" },
            typecheck: { type: "string" },
            timeout: { type: "string" },
        },
    });
    const id = sessionArg(positionals);
    const session = await collectResults(id, {
        players: values.player,
        verify: verifyOverridesFrom(values),
        skipVerification: values["no-verify"],
        timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
        log: (l) => process.stderr.write(`${l}\n`),
    });
    await mirror(session);
    if (values.json)
        jsonOut(session);
    else
        print(renderSummary(session));
    return session;
}
function cmdSummary(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } });
    const session = refreshSession(sessionArg(positionals));
    if (values.json)
        jsonOut(session);
    else
        print(renderSummary(session));
}
function cmdCompare(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { "max-diff-bytes": { type: "string" }, "no-logs": { type: "boolean" } },
    });
    const session = refreshSession(sessionArg(positionals));
    print(renderCompareBundle(session, { maxDiffBytes: values["max-diff-bytes"] ? Number(values["max-diff-bytes"]) : undefined, includeFailureLogs: !values["no-logs"] }));
}
function cmdDiff(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
    const session = refreshSession(sessionArg(positionals));
    const ref = positionals[1];
    if (!ref)
        fail("player required");
    const player = findPlayer(session, ref);
    if (!player.result)
        fail(`results not collected for ${player.id}; run: arena collect ${session.id}`);
    process.stdout.write(readFileSync(player.result.git.diffPath, "utf8"));
}
function cmdLogs(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { stderr: { type: "boolean" }, tail: { type: "string" } } });
    const session = refreshSession(sessionArg(positionals));
    const ref = positionals[1];
    if (!ref)
        fail("player required");
    const player = findPlayer(session, ref);
    const path = values.stderr ? player.stderrPath : player.stdoutPath;
    if (!existsSync(path))
        fail(`no log at ${path}`);
    let text = readFileSync(path, "utf8");
    if (values.tail)
        text = text.split("\n").slice(-Number(values.tail)).join("\n");
    process.stdout.write(text);
}
async function cmdAsk(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            question: { type: "string", short: "q" },
            "question-file": { type: "string" },
            timeout: { type: "string" },
            json: { type: "boolean" },
        },
    });
    const id = sessionArg(positionals);
    const ref = positionals[1];
    if (!ref)
        fail("player required");
    let question;
    if (values["question-file"]) {
        const p = resolve(values["question-file"]);
        if (!existsSync(p))
            fail(`question file not found: ${p}`);
        question = readFileSync(p, "utf8");
    }
    else if (values.question) {
        question = values.question;
    }
    else if (positionals.length > 2) {
        question = positionals.slice(2).join(" ");
    }
    else if (!process.stdin.isTTY) {
        question = readFileSync(0, "utf8");
    }
    else {
        question = "";
    }
    if (!question.trim())
        fail("question is required (positional text, --question, --question-file, or stdin)");
    const r = await askPlayer(id, ref, question, {
        timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
        log: (l) => process.stderr.write(`${l}\n`),
    });
    if (values.json) {
        print(JSON.stringify({ session: r.session.id, player: r.player.id, ask: r.ask, answer: r.answer }, null, 2));
        return;
    }
    const trailer = [];
    if (r.ask.timedOut)
        trailer.push(`[arena] ${r.player.label} timed out after ${formatDuration(r.ask.durationMs)}`);
    else if (r.ask.exitCode !== 0)
        trailer.push(`[arena] ${r.player.label} exited with ${r.ask.exitCode ?? "signal"} (see ${r.ask.stderrPath})`);
    if (r.ask.worktreeChanged)
        trailer.push(`[arena] warning: ${r.player.label}'s worktree changed while answering; re-run: arena collect ${r.session.id} --player ${r.player.id}`);
    trailer.push(`[arena] answer #${r.ask.n} saved: ${r.ask.answerPath} (${formatDuration(r.ask.durationMs)})`);
    print(r.answer.trim() ? r.answer : "(empty answer)");
    process.stderr.write(trailer.join("\n") + "\n");
    if (r.ask.timedOut || (r.ask.exitCode !== 0 && !r.answer.trim()))
        process.exitCode = 1;
}
async function cmdReview(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            players: { type: "string" },
            instructions: { type: "string" },
            "instructions-file": { type: "string" },
            timeout: { type: "string" },
            "max-diff-bytes": { type: "string" },
            json: { type: "boolean" },
        },
    });
    const id = sessionArg(positionals);
    let instructions;
    if (values["instructions-file"]) {
        const p = resolve(values["instructions-file"]);
        if (!existsSync(p))
            fail(`instructions file not found: ${p}`);
        instructions = readFileSync(p, "utf8");
    }
    else if (values.instructions) {
        instructions = values.instructions;
    }
    else if (positionals.length > 1) {
        instructions = positionals.slice(1).join(" ");
    }
    const r = await reviewFinal(id, {
        players: values.players ? parsePlayers(values.players) : undefined,
        instructions,
        timeoutMs: values.timeout ? Number(values.timeout) * 1000 : undefined,
        maxDiffBytes: values["max-diff-bytes"] ? Number(values["max-diff-bytes"]) : undefined,
        log: (l) => process.stderr.write(`${l}\n`),
    });
    if (values.json) {
        print(JSON.stringify({ session: r.session.id, round: r.round, answers: r.answers }, null, 2));
    }
    else {
        print(renderReviewReport(r.session, r.round, r.answers));
        const trailer = r.round.entries.filter((e) => e.worktreeChanged).map((e) => `[arena] warning: ${e.player}'s worktree changed while reviewing; re-run: arena collect ${r.session.id} --player ${e.player}`);
        trailer.push(`[arena] review round ${r.round.n} saved: ${r.round.entries.map((e) => e.answerPath).filter(Boolean).join(", ") || "(no answers)"}`);
        process.stderr.write(trailer.join("\n") + "\n");
    }
    if (r.round.entries.every((e) => e.error || e.timedOut || !r.answers[e.player]?.trim()))
        process.exitCode = 1;
}
async function cmdSelect(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } });
    const id = sessionArg(positionals);
    const ref = positionals[1];
    if (!ref)
        fail("player required (or 'none')");
    const session = selectCandidate(id, ref.toLowerCase() === "none" ? null : ref);
    await mirror(session);
    if (values.json) {
        jsonOut(session);
        return;
    }
    if (!session.selected) {
        print("Selected: none");
        return;
    }
    const p = findPlayer(session, session.selected);
    print(`Selected: ${p.label}\n\nBranch:\n${p.branch}\n\nWorktree:\n${p.worktree}\n`);
    const uncommitted = p.result ? p.result.git.changedFiles > 0 && p.result.git.commits === 0 : true;
    if (uncommitted)
        print(`Changes are in the worktree only. To make the branch self-contained:\n  arena commit ${session.id} ${p.id}`);
    print(`Merge when ready (never automatic):\n  arena adopt ${session.id}   # or: git merge ${p.branch}`);
}
function cmdCommit(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { message: { type: "string", short: "m" } } });
    const id = sessionArg(positionals);
    const ref = positionals[1];
    if (!ref)
        fail("player required");
    const r = commitCandidate(id, ref, values.message);
    print(r.committed ? `Committed ${r.player.label} candidate as ${r.commit?.slice(0, 12)} on ${r.player.branch}` : `Nothing to commit for ${r.player.label} (HEAD ${r.commit?.slice(0, 12)})`);
}
async function cmdSynthesize(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" }, "max-diff-bytes": { type: "string" } } });
    const id = sessionArg(positionals);
    const ref = positionals[1];
    if (!ref)
        fail("winner player required");
    const r = startSynthesis(id, ref);
    await mirror(r.session);
    if (values.json) {
        jsonOut(r.session);
        return;
    }
    print(renderSynthesisBrief(r.session, r.base, r.others, { maxDiffBytes: values["max-diff-bytes"] ? Number(values["max-diff-bytes"]) : undefined }));
}
async function cmdFinish(argv) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: "boolean" } } });
    const session = finishSynthesis(sessionArg(positionals));
    await mirror(session);
    if (values.json)
        jsonOut(session);
    else
        print(renderSummary(session));
}
async function cmdAdopt(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { ff: { type: "boolean" }, squash: { type: "boolean" }, message: { type: "string", short: "m" }, json: { type: "boolean" } },
    });
    const r = adoptCandidate(sessionArg(positionals), { mode: values.squash ? "squash" : values.ff ? "ff" : "merge", message: values.message });
    await mirror(r.session);
    if (values.json) {
        jsonOut(r.session);
        return;
    }
    print(`Adopted ${r.player.label} (${r.mode}) → ${r.commit.slice(0, 12)} on ${r.session.baseBranch ?? "HEAD"}`);
    print(`Not pushed. Clean up with: arena clean ${r.session.id}`);
}
function cmdOpen(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
    const session = refreshSession(sessionArg(positionals));
    if (session.status === "cleaned")
        fail(`arena ${session.id} is cleaned; its worktrees are gone`);
    const ref = positionals[1] ?? session.selected ?? undefined;
    const players = ref ? [findPlayer(session, ref)] : session.players;
    const apps = createIntegrations(loadConfig(session.repository)).filter((i) => i.status().available);
    if (!apps.length)
        fail("no workspace app CLI found (supported: orca). Worktrees:\n" + players.map((p) => `  ${p.worktree}`).join("\n"));
    for (const app of apps) {
        for (const p of players) {
            app.open(session, p);
            print(`Opened ${p.label} in ${app.label}: ${p.worktree}`);
        }
    }
}
function cmdList(argv) {
    const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" }, all: { type: "boolean" } } });
    let sessions = listSessions();
    if (!values.all)
        sessions = sessions.filter((s) => s.status !== "cleaned");
    if (values.json) {
        print(JSON.stringify(sessions, null, 2));
        return;
    }
    if (!sessions.length) {
        print("No arena sessions." + (values.all ? "" : " (use --all to include cleaned)"));
        return;
    }
    for (const s of sessions) {
        const players = s.players.map((p) => `${p.label}:${p.status}`).join(" ");
        print(`${s.id}  ${s.status.padEnd(9)}  ${s.projectName.padEnd(16)}  ${players}\n    ${s.task.split("\n")[0]?.slice(0, 100)}`);
    }
}
function cmdInspect(argv) {
    const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
    const id = sessionArg(positionals);
    process.stderr.write(`${sessionFile(id)}\n`);
    jsonOut(refreshSession(id));
}
function cmdClean(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: { "keep-branches": { type: "boolean" }, force: { type: "boolean" }, json: { type: "boolean" } },
    });
    const session = cleanArena(sessionArg(positionals), {
        deleteBranches: !values["keep-branches"],
        force: values.force,
        log: (l) => process.stderr.write(`${l}\n`),
    });
    if (values.json)
        jsonOut(session);
    else
        print(`Arena ${session.id} cleaned`);
}
async function cmdRun(argv) {
    const session = await cmdStart(argv.filter((a) => a !== "--json"));
    process.stderr.write("\n");
    const waited = await waitProgress(session.id, undefined, 15_000, true);
    if (waited.status === "stopped") {
        print(renderStatus(waited));
        return;
    }
    const collected = await collectResults(session.id, { log: (l) => process.stderr.write(`${l}\n`) });
    await mirror(collected);
    process.stderr.write("\n");
    print(renderSummary(collected));
    print(`\nNext: arena compare ${session.id} | arena select ${session.id} <player> | arena clean ${session.id}`);
}
async function main() {
    const [cmd, ...rest] = process.argv.slice(2);
    try {
        switch (cmd) {
            case undefined:
            case "-h":
            case "--help":
            case "help":
                print(HELP);
                return;
            case "install-skill":
                return cmdInstallSkill(rest);
            case "doctor":
                return await cmdDoctor(rest);
            case "refine":
                return cmdRefine(rest);
            case "start":
                await cmdStart(rest);
                return;
            case "status":
                return cmdStatus(rest);
            case "wait":
                return await cmdWait(rest);
            case "stop":
                return await cmdStop(rest);
            case "collect":
                await cmdCollect(rest);
                return;
            case "summary":
                return cmdSummary(rest);
            case "compare":
                return cmdCompare(rest);
            case "diff":
                return cmdDiff(rest);
            case "logs":
                return cmdLogs(rest);
            case "ask":
                return await cmdAsk(rest);
            case "review":
                return await cmdReview(rest);
            case "select":
                return await cmdSelect(rest);
            case "commit":
                return cmdCommit(rest);
            case "synthesize":
            case "synth":
                return await cmdSynthesize(rest);
            case "finish":
                return await cmdFinish(rest);
            case "adopt":
                return await cmdAdopt(rest);
            case "open":
                return cmdOpen(rest);
            case "list":
                return cmdList(rest);
            case "inspect":
                return cmdInspect(rest);
            case "clean":
                return cmdClean(rest);
            case "run":
                return await cmdRun(rest);
            default:
                fail(`unknown command "${cmd}"\n\n${HELP}`, 2);
        }
    }
    catch (err) {
        fail(err.message);
    }
}
await main();
