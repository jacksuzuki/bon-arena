import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import YAML from "yaml"
import { z } from "zod"
import { userConfigFile } from "./paths.ts"

const RunnerConfigSchema = z.object({
  command: z.string().optional(),
  /** Full argument list for custom runners. "{{prompt}}" / "{{promptFile}}" / "{{cwd}}" are substituted. */
  args: z.array(z.string()).optional(),
  /** Extra arguments appended to built-in runner invocations. */
  extraArgs: z.array(z.string()).optional(),
  /**
   * Custom runners only: argument list used by `arena ask` to resume the finished conversation with a
   * follow-up question. "{{prompt}}" / "{{promptFile}}" / "{{cwd}}" / "{{sessionId}}" are substituted.
   */
  askArgs: z.array(z.string()).optional(),
  label: z.string().optional(),
  model: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
})
export type RunnerConfig = z.infer<typeof RunnerConfigSchema>

const VerifyConfigSchema = z.object({
  test: z.union([z.string(), z.literal(false)]).optional(),
  lint: z.union([z.string(), z.literal(false)]).optional(),
  typecheck: z.union([z.string(), z.literal(false)]).optional(),
  /** Per-command timeout in seconds. */
  timeout: z.number().optional(),
})
export type VerifyConfig = z.infer<typeof VerifyConfigSchema>

/** Commands run inside each fresh worktree before runners start (e.g. `npm ci`). `false` disables auto-detection. */
const SetupConfigSchema = z.union([z.string(), z.array(z.string()), z.literal(false)]).optional()

/**
 * Workspace apps that mirror arena sessions. "auto" (default): only while Arena runs inside the app;
 * true: whenever its CLI is installed; false: never.
 */
const IntegrationsConfigSchema = z.object({
  orca: z.union([z.literal("auto"), z.boolean()]).default("auto"),
})

export const ArenaConfigSchema = z.object({
  runners: z.record(z.string(), RunnerConfigSchema).default({}),
  verify: VerifyConfigSchema.default({}),
  setup: SetupConfigSchema,
  /**
   * Whether hosts should refine the user's request into a one-shot specification before launching
   * (default true). `false` makes simple mode (task passed verbatim) the default.
   */
  refine: z.boolean().optional(),
  integrations: IntegrationsConfigSchema.default({ orca: "auto" }),
})
export type ArenaConfig = z.infer<typeof ArenaConfigSchema>

/** Raw `integrations` keys of a config file, so an unset key does not override the other file with its default. */
function readIntegrationKeys(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? {}
  return typeof raw.integrations === "object" && raw.integrations !== null ? raw.integrations : {}
}

function readConfigFile(path: string): ArenaConfig | null {
  if (!existsSync(path)) return null
  const raw = YAML.parse(readFileSync(path, "utf8")) ?? {}
  const parsed = ArenaConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid arena config at ${path}: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * Load user config (~/.config/arena/config.yaml) and repository config (.arena.yaml).
 * Repository config takes precedence over user config.
 */
export function loadConfig(repoPath: string): ArenaConfig {
  const user = readConfigFile(userConfigFile()) ?? ArenaConfigSchema.parse({})
  const repoFile = [".arena.yaml", ".arena.yml"].map((f) => join(repoPath, f)).find((f) => existsSync(f))
  const repo = (repoFile ? readConfigFile(repoFile) : null) ?? ArenaConfigSchema.parse({})

  const runners: Record<string, RunnerConfig> = { ...user.runners }
  for (const [id, cfg] of Object.entries(repo.runners)) {
    runners[id] = { ...(runners[id] ?? {}), ...cfg }
  }
  return {
    runners,
    verify: { ...user.verify, ...repo.verify },
    setup: repo.setup !== undefined ? repo.setup : user.setup,
    refine: repo.refine !== undefined ? repo.refine : user.refine,
    integrations: IntegrationsConfigSchema.parse({ ...readIntegrationKeys(userConfigFile()), ...(repoFile ? readIntegrationKeys(repoFile) : {}) }),
  }
}
