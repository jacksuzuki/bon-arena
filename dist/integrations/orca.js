import { realpathSync } from "node:fs";
import { formatDuration, playerDurationMs } from "../compare/summary.js";
/** True inside a terminal that Orca manages. */
export function insideOrca(env) {
    return Boolean(env.ORCA_WORKTREE_ID) || env.TERM_PROGRAM === "Orca";
}
/** Orca lists worktrees by their resolved path (e.g. /private/tmp, not /tmp). */
function selector(path) {
    try {
        return `path:${realpathSync(path)}`;
    }
    catch {
        return `path:${path}`;
    }
}
const mark = (passed) => (passed === undefined ? "–" : passed ? "✓" : "✗");
/** Board column for a candidate: running → in-progress, finished → in-review, merged → completed. */
export function orcaWorkspaceStatus(session, player) {
    if (session.adopted?.player === player.id)
        return "completed";
    return player.status === "pending" || player.status === "running" ? "in-progress" : "in-review";
}
/** One-line state of a candidate, shown as the worktree comment in Orca's sidebar. */
export function orcaComment(session, player, now = Date.now()) {
    const parts = [`${player.status} ${formatDuration(playerDurationMs(player, now))}`];
    const r = player.result;
    if (r) {
        parts.push(`${r.git.changedFiles} files +${r.git.additions} −${r.git.deletions}`);
        const v = r.verification;
        if (v.test || v.lint || v.typecheck)
            parts.push(`test ${mark(v.test?.passed)} lint ${mark(v.lint?.passed)} typecheck ${mark(v.typecheck?.passed)}`);
    }
    if (session.adopted?.player === player.id)
        parts.push(`adopted (${session.adopted.mode}) → ${session.adopted.commit.slice(0, 12)}`);
    else if (session.synthesis?.base === player.id)
        parts.push(session.synthesis.finishedAt ? "synthesis finished" : "synthesis base");
    else if (session.selected === player.id)
        parts.push("selected");
    return parts.join(" · ");
}
/**
 * Orca discovers git worktrees of a registered repo on its own, so Arena's candidates already show up
 * in its sidebar. This integration only labels them: name, status comment, board column, and the
 * worktree the arena was started from as parent. Runners stay headless under Arena Core.
 */
export function createOrcaIntegration(opts) {
    const command = opts.command ?? "orca";
    function run(args) {
        let out;
        try {
            out = opts.exec(command, [...args, "--json"]);
        }
        catch (err) {
            const e = err;
            out = e.stdout ? String(e.stdout) : "";
            if (!out.trim())
                throw new Error(e.message);
        }
        let parsed;
        try {
            parsed = JSON.parse(out);
        }
        catch {
            throw new Error(`unexpected output from ${command} ${args.slice(0, 2).join(" ")}`);
        }
        if (!parsed.ok)
            throw new Error(parsed.error?.code ?? parsed.error?.message ?? "orca command failed");
    }
    function status() {
        const available = opts.commandExists(command);
        const inside = insideOrca(opts.env);
        const base = { id: "orca", label: "Orca", available };
        if (opts.mode === false)
            return { ...base, active: false, detail: "disabled (integrations.orca: false)" };
        if (!available)
            return { ...base, active: false, detail: `${command} CLI not found in PATH` };
        if (opts.mode === true)
            return { ...base, active: true, detail: "enabled (integrations.orca: true)" };
        return inside
            ? { ...base, active: true, detail: "running inside Orca; candidate worktrees are labelled in its sidebar" }
            : { ...base, active: false, detail: "not running inside Orca (set integrations.orca: true to label worktrees anyway)" };
    }
    function sync(session) {
        if (session.status === "cleaned")
            return []; // worktrees are gone; Orca drops them by itself
        const short = session.id.split("-").pop() ?? session.id;
        return session.players.map((player) => {
            const args = [
                "worktree",
                "set",
                "--worktree",
                selector(player.worktree),
                "--display-name",
                `arena ${short} · ${player.label}`,
                "--comment",
                orcaComment(session, player),
                "--workspace-status",
                orcaWorkspaceStatus(session, player),
            ];
            try {
                try {
                    run([...args, "--parent-worktree", selector(session.repository)]);
                }
                catch {
                    // The repository itself may not be a worktree Orca knows (or lineage is refused): label without a parent.
                    run(args);
                }
                return { player: player.id, ok: true };
            }
            catch (err) {
                return { player: player.id, ok: false, error: err.message };
            }
        });
    }
    function open(_session, player) {
        run(["file", "open-changed", "--mode", "diff", "--worktree", selector(player.worktree)]);
    }
    return { id: "orca", label: "Orca", status, sync, open };
}
