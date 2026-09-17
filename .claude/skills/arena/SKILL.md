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
- Never edit files inside an arena worktree while runners are working, and never `cd` into one to
  "help" a runner. The only exception is the Synthesize step below, on the selected base candidate's
  worktree, after every runner has finished.
- Never push, and never merge, cherry-pick or delete branches without an explicit user decision.
  `arena adopt` merges only after the user says so. Cleaning is destructive: confirm first.
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

Run `arena doctor --json` in the repository root. Read `runners[]` (id, label, available),
`verify` (detected test/lint/typecheck commands) and `setup` (worktree preparation such as
`npm ci`, run before the runners start). If the repo is not a git repo or has no commits,
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
summary (repo, base branch and commit, players, setup and verification commands) and launch:

```bash
arena start --players <p1>,<p2> --json <<'ARENA_TASK'
<task text verbatim>
ARENA_TASK
```

Report the session id, branches and worktree paths from the JSON. If `start` fails with
"setup failed", show the setup log it names and offer `--no-setup` or a `.arena.yaml` `setup` entry.

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

Ask with AskUserQuestion, in this order (the first option is the default):

- **Synthesize (Recommended)** — compare, take the stronger candidate as the base, fold in the
  other's strengths, and finish the implementation yourself
- Compare only (review, then let the user pick a candidate as is)
- Inspect <Player 1> diff
- Inspect <Player 2> diff

Mention that "Keep both" and "Clean arena" are also available if the user asks.

**Compare** (used by both of the first two options): run `arena compare <id>` and review the
bundle it prints. Judge both candidates on: correctness, task completeness, regression risk,
architecture fit, code complexity, adherence to existing conventions, test quality, unnecessary
changes. Do not trust the runners' own claims: read files inside the worktrees (read-only) and, when
a claim matters (e.g. "installs cleanly", "works after X"), actually try it on a copy of the
worktree in a temp dir. Write a concise comparison: a short table of facts, per criterion which
candidate is stronger and why, then name the recommended base **and list the concrete strengths of
the other candidate worth folding in** (specific files, functions, tests, docs).

**Compare only**: after the comparison ask "Select candidate?" with <Player 1> / <Player 2> / None,
then go to step 8.

**Inspect diff**: run `arena diff <id> <player>` and walk the user through it, then return to this
question.

**Keep both**: print both branch names and worktree paths and stop.

**Clean arena**: confirm ("removes worktrees and unselected branches"), then `arena clean <id>`.

### 7. Synthesize

1. After the comparison, confirm the base with AskUserQuestion: "Base candidate?" — recommended
   candidate first, the other second, "Stop here" third.
2. Run `arena synthesize <id> <base>`. It snapshots the base candidate onto its branch, selects it,
   and prints a brief with the other candidate's diff. Relay the worktree path and the list of
   strengths you are about to fold in.
3. Work **inside the base candidate's worktree** (the path from the brief; use absolute paths, do
   not touch the user's main checkout). Keep the base's structure. Port the other candidate's
   strengths deliberately: take ideas, tests, docs and edge-case handling, not wholesale files.
   Fix defects you found in the comparison. Then polish: remove leftovers, unify naming, update
   README/docs so they describe the combined result.
4. Re-verify with `arena collect <id> --player <base>`; test / lint / typecheck must pass. If you
   cannot make them pass, say so and stop before committing.
5. Commit with `arena commit <id> <base> -m "arena(<id>): synthesis — <one line>"` and run
   `arena finish <id>`.
6. Summarize what the final version contains: what came from the base, what was folded in from
   the other candidate, what you changed yourself. Then go to step 8.

### 8. Integrate

Ask with AskUserQuestion: "Merge into <base branch> now?" with options
"Merge (arena adopt)" / "Squash merge" / "Not now, keep the branch".

- Merge: `arena adopt <id>` (or `--squash`). It refuses if the checkout is dirty or on a different
  branch; relay the message and let the user fix it. It never pushes.
- Not now: print the branch name and worktree path.

Finally offer to clean the arena (`arena clean <id>`, the selected branch is kept).

## Reference

```
arena doctor [--repo <path>] [--json]
arena start --players a,b (--task <t> | --task-file <f> | stdin) [--setup <cmd>|--no-setup] [--json]
arena status|wait|stop|summary|inspect <id|latest>
arena collect <id> [--no-verify] [--test <cmd>|false] [--lint ...] [--typecheck ...]
arena compare <id> [--max-diff-bytes <n>]
arena diff <id> <player>        arena logs <id> <player> [--stderr] [--tail n]
arena select <id> <player|none> arena commit <id> <player> [-m msg]
arena synthesize <id> <base>    arena finish <id>        arena adopt <id> [--ff|--squash]
arena list [--all]              arena clean <id> [--keep-branches] [--force]
```

State lives in `~/.arena/sessions/<id>.json`; worktrees, logs and diffs in
`~/.arena/<project>/<id>/`. Repository config: `.arena.yaml` (`runners`, `verify`, `setup`).
