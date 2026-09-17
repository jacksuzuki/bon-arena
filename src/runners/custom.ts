import type { RunnerConfig } from "../config.ts"
import { commandExists } from "./available.ts"
import type { ArenaRunner, AskInput, RunnerInput, RunnerInvocation } from "./types.ts"

/**
 * Config-defined runner (any CLI). Arguments may reference
 * {{prompt}}, {{promptFile}}, {{task}}, {{cwd}}, {{branch}}, {{arenaId}}.
 * If no argument references {{prompt}} or {{promptFile}}, the prompt is piped to stdin.
 * `askArgs` (same placeholders plus {{sessionId}}) enables `arena ask` for the runner.
 */
export function createCustomRunner(id: string, config: RunnerConfig): ArenaRunner {
  const command = config.command ?? id
  return {
    id,
    label: config.label ?? id,
    async isAvailable() {
      return commandExists(command)
    },
    invocation(input: RunnerInput): RunnerInvocation {
      const vars: Record<string, string> = {
        prompt: input.prompt,
        promptFile: input.promptPath,
        task: input.task,
        cwd: input.cwd,
        branch: input.branch,
        arenaId: input.arenaId,
      }
      const { args, promptViaStdin } = expand(config.args ?? [], vars)
      if (config.model) args.push("--model", config.model)
      args.push(...(config.extraArgs ?? []))
      return { command, args, promptViaStdin, env: config.env }
    },
    ...(config.askArgs
      ? {
          askInvocation(input: AskInput): RunnerInvocation {
            const vars: Record<string, string> = { prompt: input.prompt, promptFile: input.promptPath, cwd: input.cwd, sessionId: input.sessionId }
            const { args, promptViaStdin } = expand(config.askArgs!, vars)
            if (config.model) args.push("--model", config.model)
            return { command, args, promptViaStdin, env: config.env }
          },
        }
      : {}),
  }
}

function expand(template: string[], vars: Record<string, string>): { args: string[]; promptViaStdin: boolean } {
  const usesPrompt = template.some((a) => a.includes("{{prompt}}") || a.includes("{{promptFile}}"))
  const args = template.map((a) => a.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m))
  return { args, promptViaStdin: !usesPrompt }
}
