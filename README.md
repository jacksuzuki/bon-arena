# ccc-arena

Run two coding agents on the **same task** in **separate git worktrees**, then compare what they
produced: diff stats, tests, lint, typecheck — and pick the one you want.

```
Claude Code (/arena)
      ↓
  Arena Core  ──┬── worktree A ── Claude Code CLI
                └── worktree B ── Codex CLI
      ↓
  collect (diff, test, lint, typecheck) → compare → you decide
```

Arena Core is a small, harness-independent CLI. The Claude Code `/arena` skill is the first host;
other hosts (Codex, standalone use, other harnesses) can drive the same CLI.

## Requirements

- Node.js >= 22.18 (or Bun; the code uses only Node-compatible APIs)
- git
- Runners you want to race: `claude` (Claude Code CLI) and/or `codex` (Codex CLI) in PATH

## Install

```bash
git clone <this repo> ccc-arena
cd ccc-arena
npm install          # builds dist/ via prepare
npm link             # puts `arena` in PATH
arena doctor         # checks runners + detected verify commands
```

Make the `/arena` skill available in every Claude Code project:

```bash
ln -s "$(pwd)/.claude/skills/arena" ~/.claude/skills/arena
```

## Use from Claude Code

In any git repository:

```
/arena Replace the hand-rolled session code with Better Auth
```

Claude Code asks for Player 1 / Player 2, launches both in isolated worktrees, waits, runs
verification, shows a summary, and offers *Compare / Inspect diff / Keep both / Clean*. Selecting a
candidate prints its branch. Nothing is merged or pushed automatically.

## Use from a terminal

```bash
arena run --players claude,codex --task "Add rate limiting to the API"
# or step by step
arena start --players claude,codex --task-file task.md
arena wait latest
arena collect latest
arena compare latest        # markdown bundle for an LLM or human reviewer
arena select latest codex
arena commit latest codex   # snapshot worktree changes onto the candidate branch
arena clean latest          # removes worktrees; keeps the selected branch
```

Layout on disk:

```
~/.arena/
  sessions/<id>.json                 session state
  <project>/<id>/
    claude/  codex/                  worktrees (branches arena/<id>/<player>)
    logs/<player>.stdout.log …       runner output, exit codes
    results/<player>.diff …          diffs, status, verification logs
```

## Configuration

`~/.config/arena/config.yaml` (user) and `.arena.yaml` (repository; wins). CLI flags win over both;
auto-detection from `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` is the fallback.

```yaml
runners:
  claude:
    command: claude
    model: opus            # optional
    extraArgs: []          # appended to the built-in invocation
  codex:
    command: codex
  gemini:                  # any CLI becomes a runner
    command: gemini
    label: Gemini
    args: ["--prompt", "{{prompt}}"]   # {{prompt}} {{promptFile}} {{task}} {{cwd}} {{branch}} {{arenaId}}
    env: { SOME_FLAG: "1" }

verify:
  test: bun test
  lint: bun run lint
  typecheck: false         # false disables a check
  timeout: 600             # seconds per command
```

If a custom runner's `args` does not reference `{{prompt}}` / `{{promptFile}}`, the prompt is piped
to stdin.

## How runners are launched

Both players receive the same prompt: shared arena rules (work only in the current worktree, finish
the task completely, run tests, do not push) followed by the task verbatim.

| Runner | Invocation |
|---|---|
| Claude | `claude -p --dangerously-skip-permissions --output-format text` (prompt on stdin) |
| Codex  | `codex exec -C <worktree> --sandbox workspace-write -c approval_policy="never" -o <results>/codex.last-message.md -` |

Headless runs cannot answer permission prompts, so Claude runs with permissions skipped; isolation
comes from the dedicated worktree, not from the permission system. Each runner is supervised by a
detached process that records the exit code, so `arena` commands can exit and come back later
(`arena wait`, `arena status`). `arena stop` kills the whole process group.

The variables `CLAUDECODE` / `CLAUDE_CODE_*` are stripped from runner environments so a Claude
runner started from inside Claude Code does not think it is nested.

## Project layout

```
src/
  arena.ts            CLI (thin command surface)
  core.ts             start / wait / stop / collect / select / commit / clean
  session.ts          JSON session state (zod schema)
  config.ts           config.yaml / .arena.yaml
  git/                repository, worktree, diff
  runners/            ArenaRunner interface, claude, codex, custom, prompt
  process/            detached supervisor + spawn helpers
  verification/       detect + run test/lint/typecheck
  compare/            status, summary, markdown compare bundle
.claude/skills/arena/SKILL.md   Claude Code host
```

## Development

```bash
npm run typecheck
npm test
npm run dev -- doctor          # run from source without building
ARENA_HOME=/tmp/arena npm run dev -- run --players a,b --task "..."
```

## Not in v0.1

Automatic winner selection, cross-review, 3+ players, tournaments, cloud execution, web UI,
Superset/Orca adapters, MCP, PR creation, automatic merge, cost tracking.
