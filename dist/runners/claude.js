import { join } from "node:path";
import { commandExists } from "./available.js";
/**
 * Claude Code CLI runner.
 *
 * Runs `claude -p` headlessly. Because nobody can answer permission prompts,
 * the runner passes --dangerously-skip-permissions. Isolation comes from the
 * dedicated git worktree, not from Claude's permission system.
 */
export function createClaudeRunner(config = {}) {
    const command = config.command ?? "claude";
    return {
        id: "claude",
        label: config.label ?? "Claude",
        async isAvailable() {
            return commandExists(command);
        },
        invocation(input) {
            // Auto-memory is keyed by repository, so a runner inside a worktree would read and write the
            // host project's memory. Disable it (setting + env, both honoured by Claude Code).
            const args = ["-p", "--dangerously-skip-permissions", "--output-format", "text", "--settings", JSON.stringify({ autoMemoryEnabled: false })];
            if (config.model)
                args.push("--model", config.model);
            args.push(...(config.extraArgs ?? []));
            return {
                command,
                args,
                promptViaStdin: true,
                env: {
                    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
                    ...(config.env ?? {}),
                    // Where Claude's own transcript for this run lands is up to Claude; we just tag the run.
                    ARENA_RESULTS_DIR: join(input.resultsDir),
                },
            };
        },
    };
}
