import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { userConfigFile } from "./paths.js";
const RunnerConfigSchema = z.object({
    command: z.string().optional(),
    /** Full argument list for custom runners. "{{prompt}}" / "{{promptFile}}" / "{{cwd}}" are substituted. */
    args: z.array(z.string()).optional(),
    /** Extra arguments appended to built-in runner invocations. */
    extraArgs: z.array(z.string()).optional(),
    label: z.string().optional(),
    model: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
});
const VerifyConfigSchema = z.object({
    test: z.union([z.string(), z.literal(false)]).optional(),
    lint: z.union([z.string(), z.literal(false)]).optional(),
    typecheck: z.union([z.string(), z.literal(false)]).optional(),
    /** Per-command timeout in seconds. */
    timeout: z.number().optional(),
});
/** Commands run inside each fresh worktree before runners start (e.g. `npm ci`). `false` disables auto-detection. */
const SetupConfigSchema = z.union([z.string(), z.array(z.string()), z.literal(false)]).optional();
export const ArenaConfigSchema = z.object({
    runners: z.record(z.string(), RunnerConfigSchema).default({}),
    verify: VerifyConfigSchema.default({}),
    setup: SetupConfigSchema,
    /**
     * Whether hosts should refine the user's request into a one-shot specification before launching
     * (default true). `false` makes simple mode (task passed verbatim) the default.
     */
    refine: z.boolean().optional(),
});
function readConfigFile(path) {
    if (!existsSync(path))
        return null;
    const raw = YAML.parse(readFileSync(path, "utf8")) ?? {};
    const parsed = ArenaConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`Invalid arena config at ${path}: ${parsed.error.message}`);
    }
    return parsed.data;
}
/**
 * Load user config (~/.config/arena/config.yaml) and repository config (.arena.yaml).
 * Repository config takes precedence over user config.
 */
export function loadConfig(repoPath) {
    const user = readConfigFile(userConfigFile()) ?? ArenaConfigSchema.parse({});
    const repo = readConfigFile(join(repoPath, ".arena.yaml")) ??
        readConfigFile(join(repoPath, ".arena.yml")) ??
        ArenaConfigSchema.parse({});
    const runners = { ...user.runners };
    for (const [id, cfg] of Object.entries(repo.runners)) {
        runners[id] = { ...(runners[id] ?? {}), ...cfg };
    }
    return {
        runners,
        verify: { ...user.verify, ...repo.verify },
        setup: repo.setup !== undefined ? repo.setup : user.setup,
        refine: repo.refine !== undefined ? repo.refine : user.refine,
    };
}
