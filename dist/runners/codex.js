import { join } from "node:path";
import { commandExists } from "./available.js";
/**
 * Codex CLI runner.
 *
 * Runs `codex exec` non-interactively with the workspace-write sandbox and no
 * approval prompts (the equivalent of --full-auto). The worktree is the workspace.
 */
export function createCodexRunner(config = {}) {
    const command = config.command ?? "codex";
    return {
        id: "codex",
        label: config.label ?? "Codex",
        async isAvailable() {
            return commandExists(command);
        },
        invocation(input) {
            const args = [
                "exec",
                "-C",
                input.cwd,
                "--sandbox",
                "workspace-write",
                "-c",
                "approval_policy=\"never\"",
                "--color",
                "never",
                "-o",
                join(input.resultsDir, "codex.last-message.md"),
            ];
            if (config.model)
                args.push("--model", config.model);
            args.push(...(config.extraArgs ?? []));
            args.push("-"); // read the prompt from stdin
            return { command, args, promptViaStdin: true, env: config.env };
        },
    };
}
