---
name: arena
description: Run an implementation arena - two coding agents (Claude Code, Codex CLI, or custom runners) implement the same task in separate git worktrees, then compare diffs, tests, lint and typecheck results and let the user pick. Use when the user types /arena, wants to "compare Claude vs Codex", "race agents", or "try two implementations".
argument-hint: "[task text | status | list | resume <id> | compare <id> | clean <id>]"
---

# Arena

You are the **host harness** for Arena. Arena Core (the `arena` CLI) does the isolation, process
management, result collection and verification. You do the conversation: choose players, capture the
task, launch, report progress, and help the user compare and decide. Never re-implement Core logic.

## Ground rules

- Every arena command is non-interactive and safe to run from Bash. Use `arena` from PATH. If it is
  missing, ask the user to install the ccc-arena package globally (`npm install -g ccc-arena`
  for a published release, or `npm install -g /path/to/ccc-arena-<version>.tgz` for a release archive)
  and check that the npm global bin directory is in PATH.
- Never edit files inside an arena worktree yourself and never `cd` into one to "help" a runner.
- Never merge, cherry-pick, push, or delete branches on the user's behalf. Present branch names; the
  user integrates the winner. Cleaning is destructive: confirm first.
- Runners are already running with auto-approval inside their own worktrees. Do not start extra ones.
- Session ids look like `20260917-abc123`. `latest` is accepted everywhere.

## Route on `$ARGUMENTS`

| `$ARGUMENTS` starts with | Do |
|---|---|
| (empty) or task text | New arena (flow below). Use the text as the task if it is clearly a task. |
| `status [id]` | `arena status <id|latest>` and report. |
| `list` | `arena list` and report. |
| `resume <id>` / `wait <id>` | Continue from step 4 with that id. |
| `compare <id>` | Jump to the Compare step. |
| `clean <id>` | Confirm, then `arena clean <id>`. |

## New arena flow

### 1. Preflight

Run `arena doctor --json` in the repository root. Read `runners[]` (id, label, available) and
`verify` (detected test/lint/typecheck commands). If the repo is not a git repo or has no commits,
stop and explain. If the working tree is dirty, warn: candidates start from HEAD and will not see
uncommitted changes.

### 2. Players

Ask with AskUserQuestion, two questions in one call, options taken from available runners
(built-ins: Claude, Codex; plus any custom runners from `.arena.yaml`):

- "Player 1?" default Claude
- "Player 2?" default Codex

If a chosen runner is unavailable, say which command is missing and ask again.

### 3. Task

If `$ARGUMENTS` already contains the task, confirm it in one line. Otherwise ask the user in plain
text: "Task?" and wait. Do not paraphrase the task; pass it verbatim. Then show a one-screen launch
summary (repo, base branch and commit, players, verification commands) and launch:

```bash
arena start --players <p1>,<p2> --json <<'ARENA_TASK'
<task text verbatim>
ARENA_TASK
```

Report the session id, branches and worktree paths from the JSON.

### 4. Wait

Runners take minutes. Run the wait in the background so the Bash timeout does not cut it off:

```bash
arena wait <id> --interval 30
```

(use `run_in_background: true`). Tell the user both players are working and that they can ask for
status any time (`arena status <id>`). Do not poll in a loop yourself; the background task notifies
you when it finishes. If the user asks to abort, run `arena stop <id>`.

### 5. Collect

When wait finishes, run `arena collect <id>` (also in the background if verification is slow).
It computes diff stats and runs test / lint / typecheck **independently of what the runners
claimed**. Show its summary block verbatim in a fenced code block. If a runner status is `failed`,
show the last lines of `arena logs <id> <player> --stderr --tail 40`.

### 6. What next?

Ask with AskUserQuestion:

- Compare implementations
- Inspect <Player 1> diff
- Inspect <Player 2> diff
- Keep both
- Clean arena

**Compare implementations**: run `arena compare <id>` and review the bundle it prints. Judge both
candidates on: correctness, task completeness, regression risk, architecture fit, code complexity,
adherence to existing conventions, test quality, unnecessary changes. You may read files inside the
worktrees (read-only) for context. Write a concise comparison: a short table of facts, then per
criterion which candidate is stronger and why, then a recommendation. The user decides. Then ask
"Select candidate?" with options <Player 1> / <Player 2> / None.

**Inspect diff**: run `arena diff <id> <player>` and walk the user through it.

**Keep both**: print both branch names and worktree paths and stop.

**Clean arena**: confirm ("removes worktrees and unselected branches"), then `arena clean <id>`.

### 7. Select

`arena select <id> <player>` records the choice and prints the branch. Relay its output. If the
changes are uncommitted, offer `arena commit <id> <player>` so the branch is self-contained. Do not
merge. Finally offer to clean the arena (the selected branch is kept).

## Reference

```
arena doctor [--repo <path>] [--json]
arena start --players a,b (--task <t> | --task-file <f> | stdin) [--json]
arena status|wait|stop|summary|inspect <id|latest>
arena collect <id> [--no-verify] [--test <cmd>|false] [--lint ...] [--typecheck ...]
arena compare <id> [--max-diff-bytes <n>]
arena diff <id> <player>        arena logs <id> <player> [--stderr] [--tail n]
arena select <id> <player|none> arena commit <id> <player> [-m msg]
arena list [--all]              arena clean <id> [--keep-branches] [--force]
```

State lives in `~/.arena/sessions/<id>.json`; worktrees, logs and diffs in
`~/.arena/<project>/<id>/`. Repository config: `.arena.yaml` (`runners`, `verify`).
