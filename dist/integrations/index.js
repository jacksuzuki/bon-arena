import { execFileSync } from "node:child_process";
import { commandExists } from "../runners/available.js";
import { createOrcaIntegration } from "./orca.js";
const defaultExec = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
export function createIntegrations(config, deps = {}) {
    return [
        createOrcaIntegration({
            mode: config.integrations.orca,
            exec: deps.exec ?? defaultExec,
            commandExists: deps.commandExists ?? commandExists,
            env: deps.env ?? process.env,
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
            let entries = integration.sync(session);
            for (let attempt = 0; attempt < (opts.retries ?? 0) && entries.some((e) => !e.ok); attempt++) {
                await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 2000));
                entries = integration.sync(session);
            }
            const failed = entries.filter((e) => !e.ok);
            if (failed.length)
                log(`warning: ${integration.label} integration: ${failed.map((e) => `${e.player}: ${e.error}`).join("; ")}`);
        }
        catch (err) {
            log(`warning: ${integration.label} integration: ${err.message}`);
        }
    }
}
