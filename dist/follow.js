import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { refreshSession } from "./core.js";
import { formatDuration, playerDurationMs } from "./compare/summary.js";
import { findTranscript } from "./host.js";
import { findPlayer } from "./session.js";
const clip = (s, max = 160) => {
    const line = s.replace(/\s+/g, " ").trim();
    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
/**
 * Render one line of a Claude Code transcript (JSONL) for a live view: the assistant's text and a
 * one-line summary per tool call. Everything else (user turns, tool results, metadata) is dropped.
 */
export function renderTranscriptLine(line) {
    let entry;
    try {
        entry = JSON.parse(line);
    }
    catch {
        return [];
    }
    if (entry?.type !== "assistant" || !Array.isArray(entry.message?.content))
        return [];
    const out = [];
    for (const block of entry.message.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            out.push(block.text.trim());
        }
        else if (block.type === "tool_use") {
            const input = (block.input ?? {});
            const detail = [input.file_path, input.command, input.pattern, input.path, input.description, input.prompt].find((v) => typeof v === "string");
            out.push(`▸ ${String(block.name ?? "tool")}${detail ? `  ${clip(detail)}` : ""}`);
        }
    }
    return out;
}
/** Incremental reader of a growing file. `lines` mode holds back a trailing partial line. */
class Tail {
    offset = 0;
    rest = "";
    path;
    constructor(path) {
        this.path = path;
    }
    read() {
        if (!existsSync(this.path))
            return "";
        const size = statSync(this.path).size;
        if (size < this.offset)
            this.offset = 0; // truncated: start over
        if (size === this.offset)
            return "";
        const buf = Buffer.alloc(size - this.offset);
        const fd = openSync(this.path, "r");
        try {
            readSync(fd, buf, 0, buf.length, this.offset);
        }
        finally {
            closeSync(fd);
        }
        this.offset = size;
        return buf.toString("utf8");
    }
    readLines() {
        const text = this.rest + this.read();
        const parts = text.split("\n");
        this.rest = parts.pop() ?? "";
        return parts;
    }
}
/**
 * Stream a runner's progress until it finishes: its stdout/stderr logs, and for Claude (silent in
 * print mode until the end) the live conversation transcript instead of stdout.
 */
export async function followPlayer(sessionId, playerRef, opts = {}) {
    const write = opts.write ?? ((t) => void process.stdout.write(t));
    const first = findPlayer(refreshSession(sessionId), playerRef);
    const stdout = new Tail(first.stdoutPath);
    const stderr = new Tail(first.stderrPath);
    let transcript = null;
    write(`[arena ${sessionId}] following ${first.label} — ${first.worktree}\n`);
    for (;;) {
        const player = findPlayer(refreshSession(sessionId), playerRef);
        const active = player.status === "pending" || player.status === "running";
        if (!transcript && player.runner === "claude" && player.runnerSession) {
            const path = findTranscript(player.runnerSession, player.worktree);
            if (path)
                transcript = new Tail(path);
        }
        if (transcript) {
            for (const line of transcript.readLines()) {
                for (const rendered of renderTranscriptLine(line))
                    write(`${rendered}\n`);
            }
            stdout.read(); // the final answer is already in the transcript
        }
        else {
            write(stdout.read());
        }
        write(stderr.read());
        if (!active) {
            const exit = player.exitCode === undefined || player.exitCode === null ? "" : ` (exit ${player.exitCode})`;
            write(`\n[arena ${sessionId}] ${player.label} ${player.status}${exit} — ${formatDuration(playerDurationMs(player))}\n`);
            return player;
        }
        if (opts.signal?.aborted)
            return player;
        await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    }
}
