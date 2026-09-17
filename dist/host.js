/**
 * Host (harness) detection: which model / effort is driving the arena skill right now.
 *
 * The host does the judgement-heavy work (refine, compare, synthesize), so Arena recommends a
 * top-tier model at high effort. Detection is best-effort and read-only:
 *   - Claude Code exposes CLAUDE_CODE_SESSION_ID and CLAUDE_EFFORT to subprocesses, and writes a
 *     session transcript (~/.claude/projects/<project>/<session>.jsonl) whose assistant records
 *     carry `message.model` and `effort`.
 *   - ~/.claude/settings.json holds the configured defaults (`model`, `effortLevel`).
 * Other hosts (plain terminal, other harnesses) yield harness "unknown" and no warnings.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
export const MODEL_TIERS = [
    { pattern: /mythos|fable/i, tier: 2, label: "Mythos-class (Fable / Mythos)" },
    { pattern: /opus/i, tier: 1, label: "Opus" },
    { pattern: /sonnet/i, tier: 0, label: "Sonnet" },
    { pattern: /haiku/i, tier: 0, label: "Haiku" },
];
export const EFFORT_RANK = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };
/** Minimum: Opus-class at medium. Recommended: Mythos-class (Fable) at high or above. */
export const MIN_MODEL_TIER = 1;
export const MIN_EFFORT_RANK = EFFORT_RANK.medium;
export const RECOMMENDATION = "run the /arena host on a Mythos-class model (Fable 5.1) at effort high or above; Opus 5 at medium is the minimum. Runner models are chosen independently.";
export function modelTier(model) {
    if (!model)
        return -1;
    for (const t of MODEL_TIERS)
        if (t.pattern.test(model))
            return t.tier;
    return -1;
}
export function effortRank(effort) {
    if (!effort)
        return -1;
    return EFFORT_RANK[effort.toLowerCase()] ?? -1;
}
function claudeConfigDir() {
    return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}
/** Claude Code names the project dir by replacing every `/` and `.` in the cwd with `-`. */
export function claudeProjectDirName(cwd) {
    return cwd.replace(/[\/.]/g, "-");
}
export function findTranscript(sessionId, cwd, configDir = claudeConfigDir()) {
    const projects = join(configDir, "projects");
    const direct = join(projects, claudeProjectDirName(cwd), `${sessionId}.jsonl`);
    if (existsSync(direct))
        return direct;
    if (!existsSync(projects))
        return null;
    for (const dir of readdirSync(projects)) {
        const candidate = join(projects, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate))
            return candidate;
    }
    return null;
}
/** Read the latest assistant record's model and effort from a Claude Code transcript (tail only). */
export function readTranscriptTail(path, maxBytes = 512 * 1024) {
    const size = statSync(path).size;
    const text = readFileSync(path, "utf8");
    const tail = size > maxBytes ? text.slice(-maxBytes) : text;
    let model;
    let effort;
    for (const line of tail.split("\n").reverse()) {
        if (!line.includes('"type":"assistant"'))
            continue;
        try {
            const rec = JSON.parse(line);
            if (rec.type !== "assistant")
                continue;
            model = model ?? rec.message?.model;
            effort = effort ?? rec.effort;
            if (model && effort)
                break;
        }
        catch {
            /* partial line */
        }
    }
    return { model, effort };
}
function readSettings(configDir) {
    const p = join(configDir, "settings.json");
    if (!existsSync(p))
        return {};
    try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        return { model: j.model?.replace(/\[.*\]$/, ""), effortLevel: j.effortLevel };
    }
    catch {
        return {};
    }
}
export function rateHost(info) {
    const mt = modelTier(info.model);
    const et = effortRank(info.effort);
    const warnings = [];
    if (info.harness === "claude-code") {
        if (info.model === undefined)
            warnings.push("host model could not be detected");
        else if (mt < 0)
            warnings.push(`host model "${info.model}" is not recognised; make sure it is Opus-class or better`);
        else if (mt < MIN_MODEL_TIER)
            warnings.push(`host model "${info.model}" is below the minimum (Opus 5); the compare/refine/synthesize steps need a stronger model`);
        if (info.effort === undefined)
            warnings.push("host effort could not be detected");
        else if (et < 0)
            warnings.push(`host effort "${info.effort}" is not recognised`);
        else if (et < MIN_EFFORT_RANK)
            warnings.push(`host effort "${info.effort}" is below the minimum (medium); use /effort high for arena work`);
    }
    return { ...info, modelTier: mt, effortTier: et, warnings, recommendation: RECOMMENDATION };
}
export function detectHost(cwd = process.cwd(), env = process.env) {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    const inClaudeCode = Boolean(sessionId || env.CLAUDECODE);
    if (!inClaudeCode) {
        return rateHost({ harness: "unknown", sources: {} });
    }
    const configDir = claudeConfigDir();
    const sources = {};
    let model;
    let effort;
    if (env.CLAUDE_EFFORT) {
        effort = env.CLAUDE_EFFORT;
        sources.effort = "CLAUDE_EFFORT";
    }
    if (sessionId) {
        const transcript = findTranscript(sessionId, cwd, configDir);
        if (transcript) {
            const t = readTranscriptTail(transcript);
            if (t.model) {
                model = t.model;
                sources.model = "session transcript";
            }
            if (!effort && t.effort) {
                effort = t.effort;
                sources.effort = "session transcript";
            }
        }
    }
    const settings = readSettings(configDir);
    if (!model && settings.model) {
        model = settings.model;
        sources.model = "settings.json (configured default, may differ from the live session)";
    }
    if (!effort && settings.effortLevel) {
        effort = settings.effortLevel;
        sources.effort = "settings.json (configured default)";
    }
    return rateHost({ harness: "claude-code", sessionId, model, effort, sources });
}
export function describeHost(h) {
    if (h.harness !== "claude-code")
        return ["harness    (not Claude Code; model/effort not detected)"];
    const lines = [
        `harness    Claude Code${h.sessionId ? ` (session ${h.sessionId.slice(0, 8)})` : ""}`,
        `model      ${h.model ?? "(unknown)"}${h.sources.model ? `  [${h.sources.model}]` : ""}`,
        `effort     ${h.effort ?? "(unknown)"}${h.sources.effort ? `  [${h.sources.effort}]` : ""}`,
    ];
    for (const w of h.warnings)
        lines.push(`⚠ ${w}`);
    if (h.warnings.length)
        lines.push(`recommended: ${h.recommendation}`);
    return lines;
}
