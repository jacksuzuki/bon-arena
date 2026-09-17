import { execFileSync } from "node:child_process";
import { commandExists } from "../runners/available.js";
import { createOrcaIntegration } from "./orca.js";
const defaultExec = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Re-invoke this very CLI (works for the built dist, a checkout run with node, and global installs alike). */
function defaultFollowCommand(session, player) {
    const command = [process.execPath, process.argv[1] ?? "arena", "logs", session.id, player.id, "--follow"].map(shellQuote).join(" ");
    // The app's terminal is a fresh shell: carry a non-default state directory over.
    return process.env.ARENA_HOME ? `ARENA_HOME=${shellQuote(process.env.ARENA_HOME)} ${command}` : command;
}
export function createIntegrations(config, deps = {}) {
    return [
        createOrcaIntegration({
            mode: config.integrations.orca,
            exec: deps.exec ?? defaultExec,
            commandExists: deps.commandExists ?? commandExists,
            env: deps.env ?? process.env,
            followCommand: deps.followCommand ?? defaultFollowCommand,
        }),
    ];
}
export function integrationStatuses(config, deps = {}) {
    return createIntegrations(config, deps).map((i) => i.status());
}
/** Mirror the session into every active integration. Best effort: problems are logged, never thrown. */
export async function syncIntegrations(session, config, opts = {}, deps = {}) {
    const log = opts.log ?? (() => { });
    for (const integration of createIntegrations(config, deps)) {
        try {
            if (!integration.status().active)
                continue;
            let entries = integration.sync(session, opts.activity);
            for (let attempt = 0; attempt < (opts.retries ?? 0) && entries.some((e) => !e.ok); attempt++) {
                await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));
                entries = integration.sync(session, opts.activity);
            }
            if (opts.attach && entries.every((e) => e.ok))
                entries = integration.attach(session);
            const failed = entries.filter((e) => !e.ok);
            if (failed.length)
                log(`warning: ${integration.label} integration: ${failed.map((e) => `${e.player}: ${e.error}`).join("; ")}`);
        }
        catch (err) {
            log(`warning: ${integration.label} integration: ${err.message}`);
        }
    }
}
