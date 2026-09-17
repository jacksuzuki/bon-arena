---
name: arena
description: Run an implementation arena - two coding agents (Claude Code, Codex CLI, or custom runners) implement the same task in separate git worktrees, then compare diffs, tests, lint and typecheck results and let the user pick. By default the request is first refined with the user into a one-shot specification ("simple" skips that). Use when the user types /arena, wants to "compare Claude vs Codex", "race agents", or "try two implementations".
argument-hint: "[task <text> | task --simple <text> | task-simple <text> | status | list | resume <id> | compare <id> | clean <id>]"
---

# Arena

You are the **host harness** for Arena. Arena Core (the `arena` CLI) does the isolation, process
management, result collection and verification. You do the conversation: choose players, capture the
task, **refine it into a specification the runners can implement in one shot**, launch, report
progress, and help the user compare and decide. Never re-implement Core logic.

## Ground rules

- Every arena command is non-interactive and safe to run from Bash. Use `arena` from PATH. If it is
  missing, use `npx --yes ccc-arena` in its place for this session and tell the user to install it
  permanently with `npm install -g ccc-arena` (then `arena install-skill`), checking that the npm
  global bin directory is in PATH.
- Never edit files inside an arena worktree while runners are working, and never `cd` into one to
  "help" a runner. The only exception is the Synthesize step below, on the selected base candidate's
  worktree, after every runner has finished.
- Never push, and never merge, cherry-pick or delete branches without an explicit user decision.
  `arena adopt` merges only after the user says so. Cleaning is destructive: confirm first.
- Runners are already running with auto-approval inside their own worktrees. Do not start extra ones.
- Runners are headless: they cannot ask questions. Whatever is unclear when they start becomes a
  guess. That is why the task is refined **before** launch (step 4), never after.
- You can, however, ask *them* once they have finished: `arena ask <id> <player> "<question>"`
  resumes the runner's own conversation inside its worktree, read-only, and prints the answer. Use
  it to understand a candidate, never to have it change code: fixes are yours to make in Synthesize.
- Session ids look like `20260917-abc123`. `latest` is accepted everywhere.

## Host requirements

The host does the judgement-heavy work: refining the request, verifying the runners' claims, and
synthesizing. Run it on a Mythos-class model (Fable 5.1) at effort **high** or above; **Opus 5 at
medium is the minimum**. Runner models are chosen independently and may be cheaper. `arena doctor`
detects the live model and effort (from the Claude Code session transcript and `CLAUDE_EFFORT`)
and prints `⚠` lines when the host is below the minimum.

## Route on `$ARGUMENTS`

| `$ARGUMENTS` starts with | Do |
|---|---|
| `task <text>` or plain task text | New arena (flow below) in the default task mode (refined unless `.arena.yaml` sets `refine: false`). |
| `task --simple <text>`, `task-simple <text>`, `simple <text>`, `--simple <text>` | New arena in **simple mode**: skip step 4 and pass the text verbatim. |
| `task --refine <text>`, `refine <text>`, `--refine <text>` | New arena in **refined mode** even when the config default is simple. |
| (empty) | New arena; ask for the mode together with the players (step 2), then the task. |
| `-- <text>` | Literal task text: everything after `--` is the task even if it starts with a keyword above (e.g. `/arena -- simple retry logic for the client`). |
| `status [id]` | `arena status <id|latest>` and report. |
| `list` | `arena list` and report. |
| `resume <id>` / `wait <id>` | Continue from step 6 with that id. |
| `compare <id>` | Jump to step 8 (compare, then "What next?"). |
| `clean <id>` | Confirm, then `arena clean <id>`. |

Mode keywords are recognised only as the leading token (or as the first flag right after `task`);
a `simple` or `refine` later in the text is just text. The mode is fixed before any work starts: it
is never offered again at the confirmation step. Modes apply to new arenas only: status, resume,
compare and clean never refine or relaunch an existing session's task. `simple` / `refine` are host
options, never passed to the CLI.

## New arena flow

### 1. Preflight

Run `arena doctor --json` in the repository root. Read `runners[]` (id, label, available),
`verify` (detected test/lint/typecheck commands), `setup` (worktree preparation such as
`npm ci`, run before the runners start), `taskMode` (`refined` or `simple`: the default when the
user did not choose one on the command line) and `host` (detected harness, model, effort,
`warnings[]`). If the repo is not a git repo or has no commits, stop and explain. If the working
tree is dirty, warn: candidates start from HEAD and will not see uncommitted changes.

If `host.warnings` is non-empty, tell the user before anything else: quote the warnings, name the
detected model and effort, and say that the comparison and synthesis quality depends on them
(`/model` and `/effort` change them). Then continue; the user decides whether to proceed. If
detection failed (`model` or `effort` unknown), state which model you are running as according to
your own system prompt and continue.

### 2. Players

Ask with AskUserQuestion, two questions in one call, options taken from available runners
(built-ins: Claude, Codex; plus any custom runners from `.arena.yaml`):

- "Player 1?" default Claude
- "Player 2?" default Codex
- "Task mode?" — only when `$ARGUMENTS` did not fix the mode: **Refine first (Recommended)** (you
  read the code, ask what is unclear, and write a one-shot specification before launching) /
  **Simple** (pass the request to the runners verbatim). Skip this question when the mode came
  from the arguments or the user has stated it.

If a chosen runner is unavailable, say which command is missing and ask again.

### 3. Task

If `$ARGUMENTS` already contains the task, confirm it in one line. Otherwise ask the user in plain
text: "Task?" and wait. Never paraphrase what the user typed: this text is the **original request**
and is recorded as such. Then:

- **Simple mode** → go to step 5 with the original request as the task.
- **Refined mode** (default) → step 4.

### 4. Refine (skipped in simple mode)

Goal: turn the request into a specification that two independent, headless runners could implement
in one pass without guessing. You clarify; you do **not** implement anything here, and you do not
create worktrees, run setup or launch runners until the user confirms in step 4.7.

1. Run `arena refine` with the original request. It saves the request as a draft file (path in the
   output), prints repository facts and the specification template, and is the procedure to follow:

   ```bash
   arena refine <<'ARENA_TASK'
   <original request verbatim>
   ARENA_TASK
   ```

2. **Understand.** Restate the request in one sentence. Read the code it touches (read-only, in the
   user's checkout): entry points, the modules to change, existing tests, naming and error-handling
   conventions. Use subagents for broad searches if the repo is large. Candidates start from the
   preflight HEAD: if a relevant file is dirty or untracked, look at the committed version
   (`git show HEAD:<path>`) and do not base the specification on changes the runners will not get.
3. **Find the gaps.** List every decision a runner would otherwise have to guess: scope boundaries,
   affected files/modules, behavior in edge cases, public API and naming, backward compatibility,
   user-facing text, expected tests, what must not change.
4. **Settle what you can** from the code, the project's conventions and sensible defaults. Keep a
   note of each decision.
5. **Ask only what remains** with AskUserQuestion: batch up to four questions per call, each with
   concrete options and a recommended default; at most two rounds. If the user defers ("you decide",
   "お任せ"), choose and record the choice. If nothing is genuinely unclear, ask nothing and say so.
6. **Write the specification** using the template `arena refine` printed (Goal, Background, Scope
   in/out, Requirements, Acceptance criteria, Constraints, Verification, Decisions); omit sections
   that would be empty. Integrate the answers; no Q&A transcript. Keep the user's language and the
   user's exact identifiers and examples. Be concrete about *what*: name files, functions, commands,
   messages, edge cases, and include the verification commands from `arena doctor`. Do not
   over-prescribe *how*: the point of an arena is that two runners may solve it differently, so leave
   design and implementation choices open unless the user or the codebase fixes them. Never invent
   requirements the user did not ask for, and never resolve conflicting requirements by silently
   dropping one — ask.
7. **Confirm.** Show the full specification and ask with AskUserQuestion: "Launch with this
   specification?" with options **Launch** / **Edit** (take the user's changes and show it again) /
   **Cancel** (end without creating a session). Do not offer a switch to simple mode here: the mode
   was chosen up front, and a half-refined draft must never be sent. If the user already told you
   to launch as soon as the specification is ready, do not ask again.

Scale the effort to the task: a one-line bug fix with an obvious location needs a short
specification and no questions; a feature that touches several modules deserves the full template.

### 5. Launch

Show a one-screen launch summary (repo, base branch and commit, players, task mode, setup and
verification commands), then start.

Refined mode, using the draft path printed by `arena refine`:

```bash
arena start --players <p1>,<p2> --original-task-file <draft path> --json <<'ARENA_TASK'
<refined specification>
ARENA_TASK
```

Simple mode:

```bash
arena start --players <p1>,<p2> --json <<'ARENA_TASK'
<original request verbatim>
ARENA_TASK
```

Runners receive only the task text you pass here (plus the shared arena rules), so the text must be
self-contained: never refer to "the discussion above". Always pass it via stdin heredoc or
`--task-file`, never by interpolating it into a shell string; pick a heredoc delimiter that does not
occur as a line of the task. In refined mode the original request is stored with the session for
reviewers and shown in `arena compare`.
Report the session id, branches and worktree paths from the JSON. If `start` fails with
"setup failed", show the setup log it names and offer `--no-setup` or a `.arena.yaml` `setup` entry.

### 6. Wait

Runners take minutes. Run the wait in the background so the Bash timeout does not cut it off:

```bash
arena wait <id> --interval 30
```

(use `run_in_background: true`). Tell the user both players are working and that they can ask for
status any time (`arena status <id>`). Do not poll in a loop yourself; the background task notifies
you when it finishes. If the user asks to abort, run `arena stop <id>`.

### 7. Collect

When wait finishes, run `arena collect <id>` (also in the background if verification is slow).
It computes diff stats and runs test / lint / typecheck **independently of what the runners
claimed**. Show its summary block verbatim in a fenced code block. If a runner status is `failed`,
show the last lines of `arena logs <id> <player> --stderr --tail 40`.

### 8. Compare (always, right after collect)

Do this before asking the user anything: they cannot decide between synthesizing and adopting a
candidate as is without seeing the review.

Run `arena compare <id>` and review the bundle it prints. Judge both candidates on: correctness,
task completeness, regression risk, architecture fit, code complexity, adherence to existing
conventions, test quality, unnecessary changes. In refined mode the bundle contains both the
specification and the original request: judge completeness against the specification, and check
that the result still serves the original request. Do not trust the runners' own claims: read files
inside the worktrees (read-only) and, when a claim matters (e.g. "installs cleanly", "works after
X"), actually try it on a copy of the worktree in a temp dir.

When something about a candidate is unclear from the code and logs alone — why a requirement was
skipped, what a puzzling change is for, whether a failing check was known, which of two behaviours
was intended — ask the runner itself before judging:

```bash
arena ask <id> <player> "<one specific question>"
```

It resumes that runner's conversation (Claude session / Codex thread) in its worktree with
inspection-only permissions and prints the answer; the answer is saved and included in later
`arena compare` output. Ask one concrete question at a time, at most a few per candidate, and
treat the reply as the runner's account, not as verified fact. If the output warns that the
worktree changed, re-run `arena collect <id> --player <player>`. If it reports that the conversation
cannot be resumed (cleaned worktree, custom runner without `askArgs`, older session), fall back to
the logs and the diff.

Present a concise comparison to the user:

1. a short table of facts (duration, files, diff size, verification results, approach in one line);
2. per criterion, which candidate is stronger and why, including any defect you found;
3. the recommended base, **the concrete strengths of the other candidate worth folding in**
   (specific files, functions, tests, docs), and whether a plain adoption would already be good
   enough or synthesis adds real value.

### 9. What next?

Only now ask with AskUserQuestion, in this order (the first option is the default):

- **Synthesize (Recommended)** — base on <recommended>, fold in <other>'s strengths listed above,
  and finish the implementation yourself
- Adopt <recommended> as is
- Adopt <other> as is
- Inspect a diff (then return to this question)

If the user wants to interrogate a candidate first ("ask Codex why…"), run `arena ask` with their
question, relay the answer, and ask this question again.

Mention that "Keep both" and "Clean arena" are also available if the user asks. If the comparison
showed that one candidate is clearly complete and the other adds nothing worth porting, say so and
still list Synthesize first, but note that adopting as is would be a fine choice.

**Adopt as is**: `arena select <id> <player>`, relay its output, then go to step 11.

**Inspect a diff**: ask which player, run `arena diff <id> <player>` and walk the user through it,
then ask this question again.

**Keep both**: print both branch names and worktree paths and stop.

**Clean arena**: confirm ("removes worktrees and unselected branches"), then `arena clean <id>`.

### 10. Synthesize

1. The base is the recommended candidate from step 8 unless the user named another one when
   choosing Synthesize; if their answer suggests a different base, confirm with AskUserQuestion:
   "Base candidate?" — recommended first, the other second, "Stop here" third.
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
   the other candidate, what you changed yourself. Then go to step 11.

### 11. Integrate

Ask with AskUserQuestion: "Merge into <base branch> now?" with options
"Merge (arena adopt)" / "Squash merge" / "Not now, keep the branch".

- Merge: `arena adopt <id>` (or `--squash`). It refuses if the checkout is dirty or on a different
  branch; relay the message and let the user fix it. It never pushes.
- Not now: print the branch name and worktree path.

Finally offer to clean the arena (`arena clean <id>`, the selected branch is kept).

## Reference

```
arena doctor [--repo <path>] [--json]                 (json includes taskMode: refined|simple)
arena refine (--task <t> | --task-file <f> | stdin) [--no-draft] [--json]
arena start --players a,b (--task <t> | --task-file <f> | stdin)
            [--original-task <t> | --original-task-file <f>]   (present = refined mode)
            [--setup <cmd>|--no-setup] [--json]
arena status|wait|stop|summary|inspect <id|latest>
arena collect <id> [--no-verify] [--test <cmd>|false] [--lint ...] [--typecheck ...]
arena compare <id> [--max-diff-bytes <n>]
arena diff <id> <player>        arena logs <id> <player> [--stderr] [--tail n]
arena ask <id> <player> "<question>" [--question-file <f>] [--timeout <sec>]   (read-only; after the runner finished)
arena select <id> <player|none> arena commit <id> <player> [-m msg]
arena synthesize <id> <base>    arena finish <id>        arena adopt <id> [--ff|--squash]
arena list [--all]              arena clean <id> [--keep-branches] [--force]
```

State lives in `~/.arena/sessions/<id>.json`; worktrees, logs and diffs in
`~/.arena/<project>/<id>/` (`task.md` is what the runners got, `task.original.md` the request
before refinement); drafts from `arena refine` in `~/.arena/drafts/`. Repository config:
`.arena.yaml` (`runners`, `verify`, `setup`, `refine: false` to default to simple mode).
