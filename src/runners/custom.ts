import type { RunnerConfig } from "../config.ts"
import { commandExists } from "./available.ts"
import type { ArenaRunner, RunnerInput, RunnerInvocation } from "./types.ts"

/**
 * Config-defined runner (any CLI). Arguments may reference
 * {{prompt}}, {{promptFile}}, {{task}}, {{cwd}}, {{branch}}, {{arenaId}}.
 * If no argument references {{prompt}} or {{promptFile}}, the prompt is piped to stdin.
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
      const template = config.args ?? []
      const usesPrompt = template.some((a) => a.includes("{{prompt}}") || a.includes("{{promptFile}}"))
      const args = template.map((a) => a.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m))
      if (config.model) args.push("--model", config.model)
      args.push(...(config.extraArgs ?? []))
      return { command, args, promptViaStdin: !usesPrompt, env: config.env }
    },
  }
}
