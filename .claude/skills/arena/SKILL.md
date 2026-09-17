---
name: arena
description: Run an implementation arena - two or three coding agents (Claude Code, Codex CLI, Antigravity CLI, or custom runners) implement the same task in separate git worktrees, then compare diffs, tests, lint and typecheck results and let the user pick. By default the request is first refined with the user into a one-shot specification ("simple" skips that). Use when the user types /arena, wants to "compare Claude vs Codex", "race agents", or "try two implementations".
argument-hint: "[task <text> | task --simple <text> | task-simple <text> | status | list | resume <id> | compare <id> | clean <id>]"
---

# Arena

You are the **host harness** for Arena. Arena Core (the `arena` CLI) does the isolation, process
management, result collection and verification. You do the conversation: choose players, capture the
task, **refine it into a specification the runners can implement in one shot**, launch, report
progress, and help the user compare and decide. Never re-implement Core logic.

## Ground rules

- Every arena command is non-interactive and safe to run from Bash. Use `arena` from PATH. If it is
  missing, use `npx --yes bon-arena` in its place for this session and tell the user to install it
  permanently with `npm install -g bon-arena` (then `arena install-skill`), checking that the npm
  global bin directory is in PATH.
- Never edit files inside an arena worktree while runners are working, and never `cd` into one to
  "help" a runner. The only exceptions are the Synthesize and Review steps below, on the selected
  candidate's worktree, after every runner has finished.
- Never push, and never merge, cherry-pick or delete branches without an explicit user decision.
  `arena adopt` merges only after the user says so. Cleaning is destructive: confirm first.
- Runners are already running with auto-approval inside their own worktrees. Do not start extra ones.
- Runners are headless: they cannot ask questions. Whatever is unclear when they start becomes a
  guess. That is why the task is refined **before** launch (step 4), never after.
- You can, however, ask *them* once they have finished: `arena ask <id> <player> "<question>"`
  resumes the runner's own conversation inside its worktree, read-only, and prints the answer. Use
  it to understand a candidate, never to have it change code: fixes are yours to make in Synthesize.
  After you have produced the final version, `arena review <id>` has every runner review it the same
  way (step 11); their findings are input for you, never instructions to them.
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

Ask with AskUserQuestion, all questions in one call, options taken from available runners
(built-ins: Claude, Codex, Antigravity (`agy`); plus any custom runners from `.arena.yaml`):

- "Player 1?" default Claude
- "Player 2?" default Codex
- "Player 3?" default **None** (first option; two players), then the available runners. An arena
  has two or three players; never offer a fourth.
- "Task mode?" — only when `$ARGUMENTS` did not fix the mode: **Refine first (Recommended)** (you
  read the code, ask what is unclear, and write a one-shot specification before launching) /
  **Simple** (pass the request to the runners verbatim). Skip this question when the mode came
  from the arguments or the user has stated it.

The same runner may be chosen more than once; its players are then named `<runner>`,
`<runner>-2`, `<runner>-3` (use those ids wherever a command takes `<player>`). When the user
already named the players ("claude, codex and agy"), skip the questions they answered. If a chosen
runner is unavailable, say which command is missing and ask again.

### 3. Task

If `$ARGUMENTS` already contains the task, confirm it in one line. Otherwise ask the user in plain
text: "Task?" and wait. Never paraphrase what the user typed: this text is the **original request**
and is recorded as such. Then:

- **Simple mode** → go to step 5 with the original request as the task.
- **Refined mode** (default) → step 4.

### 4. Refine (skipped in simple mode)

Goal: turn the request into a specification that independent, headless runners could implement
in one pass without guessing **what is wanted**. You clarify; you do **not** implement anything
here, and you do not create worktrees, run setup or launch runners until the user confirms in
step 4.7.

Stay on your side of the line. An arena is a best-of-N: its value is that independent runners
investigate and design differently. Whatever you investigate or design for them is shared by every
candidate, including your mistakes, and the candidates converge. You own the user's intent, the
user's decisions and the observable acceptance criteria. The runners own the investigation (reading
the code in depth, probing tools and APIs) and the design (files, structure, internal names,
approach).

1. Run `arena refine` with the original request. It saves the request as a draft file (path in the
   output), prints repository facts and the specification template, and is the procedure to follow:

   ```bash
   arena refine <<'ARENA_TASK'
   <original request verbatim>
   ARENA_TASK
   ```

2. **Understand.** Restate the request in one sentence. Read code (read-only, in the user's
   checkout) only as far as needed to see what the request means here and where it is ambiguous.
   Do not work out the implementation, and do not try out tools, CLIs or APIs on the runners'
   behalf: that is their job, and each should do it independently. Candidates start from the
   preflight HEAD: if a relevant file is dirty or untracked, look at the committed version
   (`git show HEAD:<path>`) and do not base the specification on changes the runners will not get.
3. **Find the gaps** in *what is wanted*: scope boundaries, behavior in edge cases, public API and
   user-facing names and text, backward compatibility, what must not change. Choices about *how*
   (which files, structure, internal names, approach) are not gaps; list the notable ones under
   "Open to the implementer" instead of deciding them.
4. **Settle what you can** of those gaps from the project's conventions and sensible defaults.
   Keep a note of each decision.
5. **Ask only what remains** with AskUserQuestion: batch up to four questions per call, each with
   concrete options and a recommended default; at most two rounds. If the user defers ("you decide",
   "お任せ"), choose and record the choice. If nothing is genuinely unclear, ask nothing and say so.
6. **Write the specification** using the template `arena refine` printed (Goal, Context, Scope
   in/out, Requirements, Acceptance criteria, Constraints, Verification, Decisions, Open to the
   implementer, Notes (unverified)); omit sections that would be empty. Integrate the answers; no
   Q&A transcript. Keep the user's language and the user's exact identifiers and examples.
   - Be concrete about *what*: commands, inputs and outputs, user-facing names and messages, edge
     cases, and the verification commands from `arena doctor`.
   - Write acceptance criteria as checks on observable behavior that any good implementation would
     pass. Never assert internal structure (function names, argument layout, file placement).
   - Do not describe the existing code; runners read it themselves. "Context" is for what they
     cannot find in the repository.
   - Test every line: would a different, equally good implementation violate it? If so, and neither
     the user nor a public contract demands it, delete it or move it to "Open to the implementer".
   - Implementation facts you happened to learn go under "Notes (unverified)" — runners are told to
     check them, not obey them — or nowhere. Keep that section short.
   - Never invent requirements the user did not ask for, and never resolve conflicting requirements
     by silently dropping one — ask.
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
arena start --players <p1>,<p2>[,<p3>] --original-task-file <draft path> --json <<'ARENA_TASK'
<refined specification>
ARENA_TASK
```

Simple mode:

```bash
arena start --players <p1>,<p2>[,<p3>] --json <<'ARENA_TASK'
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

(use `run_in_background: true`). Tell the user the players are working and that they can ask for
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

Run `arena compare <id>` and review the bundle it prints. Judge every candidate on: correctness,
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

It resumes that runner's conversation (Claude session / Codex thread / Antigravity conversation) in
its worktree with inspection-only permissions (best effort for Antigravity: `agy` has no read-only
mode, so watch for the worktree-changed warning) and prints the answer; the answer is saved and included in later
`arena compare` output. Ask one concrete question at a time, at most a few per candidate, and
treat the reply as the runner's account, not as verified fact. If the output warns that the
worktree changed, re-run `arena collect <id> --player <player>`. If it reports that the conversation
cannot be resumed (cleaned worktree, custom runner without `askArgs`, older session), fall back to
the logs and the diff.

Present a concise comparison to the user:

1. a short table of facts (duration, files, diff size, verification results, approach in one line);
2. per criterion, which candidate is stronger and why, including any defect you found;
3. the recommended base, **the concrete strengths of each other candidate worth folding in**
   (specific files, functions, tests, docs), and whether a plain adoption would already be good
   enough or synthesis adds real value.

When `arena doctor` lists a workspace app as active (Orca), the candidates already appear in its
sidebar as `arena <id> · <Label>` with their status, grouped under the worktree the arena was
started from, each with a `<Label> (live)` terminal streaming the runner's progress; the CLI keeps
that in sync on its own. If `arena doctor` or `arena start` printed a `note:` about the app (e.g.
Orca hides discovered worktrees for this project), relay that note instead of claiming the
candidates are visible. Mention once that `arena open <id> <player>`
shows a candidate's changed files as diffs in the app, and run it when the user wants to look.

### 9. What next?

Only now ask with AskUserQuestion, in this order (the first option is the default):

- **Synthesize (Recommended)** — base on <recommended>, fold in the strengths of the other
  candidate(s) listed above, and finish the implementation yourself
- Adopt <recommended> as is
- Adopt <other> as is (one option per other candidate)
- Inspect a diff (then return to this question) — with three candidates the four options are
  taken; say in the question text that "inspect a diff" can be typed instead

If the user wants to interrogate a candidate first ("ask Codex why…"), run `arena ask` with their
question, relay the answer, and ask this question again.

Mention that "Keep all" and "Clean arena" are also available if the user asks. If the comparison
showed that one candidate is clearly complete and the others add nothing worth porting, say so and
still list Synthesize first, but note that adopting as is would be a fine choice.

**Adopt as is**: `arena select <id> <player>`, relay its output, then go to step 11 (Review).

**Inspect a diff**: ask which player, run `arena diff <id> <player>` and walk the user through it,
then ask this question again.

**Keep all**: print every branch name and worktree path and stop.

**Clean arena**: confirm ("removes worktrees and unselected branches"), then `arena clean <id>`.

### 10. Synthesize

1. The base is the recommended candidate from step 8 unless the user named another one when
   choosing Synthesize; if their answer suggests a different base, confirm with AskUserQuestion:
   "Base candidate?" — recommended first, the others next, "Stop here" last.
2. Run `arena synthesize <id> <base>`. It snapshots the base candidate onto its branch, selects it,
   and prints a brief with the diff of every other candidate. Relay the worktree path and the list of
   strengths you are about to fold in.
3. Work **inside the base candidate's worktree** (the path from the brief; use absolute paths, do
   not touch the user's main checkout). Keep the base's structure. Port the other candidates'
   strengths deliberately: take ideas, tests, docs and edge-case handling, not wholesale files.
   Fix defects you found in the comparison. Then polish: remove leftovers, unify naming, update
   README/docs so they describe the combined result.
4. Re-verify with `arena collect <id> --player <base>`; test / lint / typecheck must pass. If you
   cannot make them pass, say so and stop before committing.
5. Commit with `arena commit <id> <base> -m "arena(<id>): synthesis — <one line>"` and run
   `arena finish <id>`.
6. Summarize what the final version contains: what came from the base, what was folded in from
   each other candidate, what you changed yourself. Then go to step 11.

### 11. Review (always, before integrating)

The final version, whether synthesized or adopted as is, gets a review from every runner before
the user is asked to merge it. Run it in the background (reviewers take minutes):

```bash
arena review <id>
```

(use `run_in_background: true`). It resumes each runner's conversation read-only, in parallel,
with the diff from the base commit to the selected candidate's worktree and an explanation of how
the final version relates to that runner's own candidate. Each answer starts with
`VERDICT: approve` or `VERDICT: request-changes` followed by findings ordered by severity
(`blocker`, `major`, `minor`, `nit`). Add `--instructions "<text>"` when you want the reviewers to
concentrate on something (a risky module, a requirement you were unsure about). The report is
printed and saved under `results/<player>.review-<n>.md`; `arena summary` shows the verdicts.

Then triage:

1. Verify every blocker and major finding yourself against the code in the selected worktree
   (read-only first). Reviewers reason from the diff and their own run; they can be wrong, and the
   runner whose candidate was not chosen may argue for its own design. Accept a finding only when
   you can point at the defect.
2. Fix the accepted findings inside the selected candidate's worktree (the same rules as in
   Synthesize: absolute paths, never the user's checkout). Re-verify with
   `arena collect <id> --player <selected>` and commit with `arena commit <id> <selected> -m
   "arena(<id>): review fixes — <one line>"`.
3. If you changed code, run `arena review <id>` once more so every runner sees the fixed version.
   Stop after two rounds regardless; remaining disagreements go to the user.
4. Present a short review summary: each runner's verdict per round, which findings you accepted
   (and fixed) and which you rejected with the reason. A `request-changes` you decided not to act
   on must be visible to the user here.

If a runner cannot be asked (`not asked` in the report: cleaned worktree, custom runner without
`askArgs`, older session) or times out, say so and continue with the reviews you have. Never skip
this step silently; if the user explicitly wants to merge without a review, note that in the summary.

### 12. Integrate

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
arena diff <id> <player>        arena logs <id> <player> [--stderr] [--tail n] [--follow]
arena ask <id> <player> "<question>" [--question-file <f>] [--timeout <sec>]   (read-only; after the runner finished)
arena review <id> [--players a,b] [--instructions "<text>"] [--timeout <sec>]  (every runner reviews the selected final version, read-only)
arena select <id> <player|none> arena commit <id> <player> [-m msg]
arena synthesize <id> <base>    arena finish <id>        arena adopt <id> [--ff|--squash]
arena open <id> [player]        (show changed files in the workspace app; Orca)
arena list [--all]              arena clean <id> [--keep-branches] [--force]
```

State lives in `~/.arena/sessions/<id>.json`; worktrees, logs and diffs in
`~/.arena/<project>/<id>/` (`task.md` is what the runners got, `task.original.md` the request
before refinement); drafts from `arena refine` in `~/.arena/drafts/`. Repository config:
`.arena.yaml` (`runners`, `verify`, `setup`, `refine: false` to default to simple mode,
`integrations.orca: auto|true|false`).
