# bon-arena

**English** | [日本語](docs/README.ja.md) | [简体中文](docs/README.zh-CN.md)

Run two coding agents on the **same task** in **separate git worktrees**, then compare what they
produced: diff stats, tests, lint, typecheck — and pick the one you want.

```
Claude Code (/arena)
      ↓
  refine the request with you into a one-shot specification   (skip with "simple")
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
- Runners you want to race in PATH: `claude` (Claude Code CLI), `codex` (Codex CLI) and/or `agy`
  (Antigravity CLI). These three are built in; any other CLI can be added in the configuration

## Install

Published on npm as [`bon-arena`](https://www.npmjs.com/package/bon-arena) (Node.js >= 22.18):

```bash
npm install -g bon-arena
arena install-skill
arena doctor         # run in the project you want to work on
```

To update, run `npm install -g bon-arena@latest` and then `arena install-skill --force`. To
uninstall, run `npm uninstall -g bon-arena` and remove `skills/arena` from your Claude Code config
directory if no longer needed. Arena sessions and candidate worktrees are not removed by
uninstalling the package. If `arena` is not found after installation, add the npm global bin
directory to PATH (`$(npm prefix -g)/bin` on macOS/Linux, `npm prefix -g` on Windows). git is
required when running arenas because candidate implementations use git worktrees.

### Zero-install (npx)

```bash
npx bon-arena doctor
npx bon-arena run --players claude,codex --task "Add rate limiting"
```

The Claude Code skill calls `arena` from PATH and falls back to `npx bon-arena` when it is
missing, but the global install is faster and lets you use `/arena` without any prompt.

### From GitHub or a checkout

The compiled CLI (`dist/`) is committed, so the repository installs without a build step:
`npm install -g --install-links github:jacksuzuki/bon-arena` (the flag matters: without it npm 10
installs a git package as a symlink to a temporary clone that it deletes right away) or
`npx --package github:jacksuzuki/bon-arena arena doctor`. Pin a version with `#v0.4.0`. For
development:

```bash
git clone https://github.com/jacksuzuki/bon-arena.git
cd bon-arena
npm ci
npm run build        # dist/ is committed; rebuild after changing src/
npm link             # expose this checkout as the arena command
arena install-skill
```

`arena install-skill` copies the bundled skill to `~/.claude/skills/arena/SKILL.md`; no symlink or
repository path is needed. Restart Claude Code after installation. It respects `CLAUDE_CONFIG_DIR`,
or use `arena install-skill --config-dir /path/to/claude-config`. Repeating it is safe: identical
content is left alone, and different content is preserved unless you pass `--force`. Use `--force`
to update the skill after upgrading or to replace the old checkout-based symlink.

## Host model recommendation

The `/arena` host does the judgement-heavy work: refining the request into a specification,
verifying the runners' claims, and synthesizing the final version. Run it on a Mythos-class model
(Fable 5.1) at effort **high** or above; **Opus 5 at medium is the minimum**. Runner models are
chosen independently and may be cheaper.

`arena doctor` detects the live host inside Claude Code (session transcript + `CLAUDE_EFFORT`) and
prints `⚠` warnings when the host is below the minimum; the skill relays them before starting:

```
host
  harness    Claude Code (session c8e40442)
  model      claude-fable-5-1  [session transcript]
  effort     high  [CLAUDE_EFFORT]
```

Outside Claude Code the host is reported as not detected and no warning is given.

## Use from Claude Code

In any git repository:

```
/arena Replace the hand-rolled session code with Better Auth
```

Claude Code asks for Player 1 / Player 2, then **refines the task** before anything is launched:
it reads the code the request touches, works out what the runners would otherwise have to guess
(scope, affected files, edge cases, naming, compatibility, tests), asks you only about the points it
cannot settle itself, and writes a specification (goal, scope, requirements, acceptance criteria,
constraints, verification, decisions). You approve or edit it, and only then are both players
launched in isolated worktrees with that specification. The runners are headless and cannot ask
questions, so this is the step that keeps them from guessing differently. Your original request is
stored with the session and shown next to the specification in `arena compare`.

Skip the refinement with **simple mode**, chosen up front on the command line, which passes your
text to the runners verbatim:

```
/arena task --simple Rename the `Session` type to `ArenaSession`
/arena task-simple Rename the `Session` type to `ArenaSession`      # same thing
```

`/arena task <text>` (or plain text) refines by default; `/arena` with no arguments asks for the
mode along with the players. `refine: false` in `.arena.yaml` makes simple mode the default for a
repository, `task --refine` forces refinement, and `/arena -- <text>` sends text that happens to
start with a keyword. During refinement nothing is launched; you can edit the specification or
cancel before any worktree exists. The mode is not offered again at the confirmation step.

After the runners finish, Claude Code waits, runs verification, shows a summary and **always
presents a comparison first**: facts, per-criterion judgement, the recommended base and what the
other candidate does better. Only then does it ask what to do. The recommended option is
**Synthesize**: take the stronger candidate as the base, fold in the other's strengths inside that
candidate's worktree, re-run verification, and commit the result on the candidate branch. You can
also adopt either candidate as is. Before asking you to merge, Claude Code has **both runners
review the final version** (`arena review`): each resumes its own conversation read-only, sees the
final diff, and answers with a verdict and findings; Claude Code verifies the findings, fixes the
ones it accepts, and shows you what it rejected and why. Merging into your branch (`arena adopt`)
happens only when you say so, and nothing is ever pushed.

## Use from a terminal

```bash
arena run --players claude,codex --task "Add rate limiting to the API"   # simple mode: text goes to the runners verbatim
arena run --players claude,agy --task "Add rate limiting to the API"     # any built-in: claude, codex, agy (Antigravity)
# or step by step
arena start --players claude,codex --task-file task.md
arena wait latest
arena collect latest
arena compare latest        # markdown bundle for an LLM or human reviewer
arena ask latest codex "Why is the retry capped at 2?"   # resume the runner's own conversation, read-only
arena select latest codex
arena commit latest codex   # snapshot worktree changes onto the candidate branch
arena adopt latest          # merge the selected branch into the current branch (--ff / --squash)
arena clean latest          # removes worktrees; keeps the selected branch

# finishing pass driven by a host (Claude Code does this for you in /arena)
arena synthesize latest codex          # snapshot + select the base, print the other candidate's diff
#   ...edit inside the codex worktree...
arena collect latest --player codex    # re-verify
arena commit latest codex -m "arena: synthesis"
arena finish latest
arena review latest                    # every runner reviews the final version (read-only, in parallel)
arena review latest --instructions "Focus on the retry path"   # optional steer; --players codex limits reviewers
```

Omitting `--players` still means `claude,codex`. `arena doctor` lists all three built-ins; a missing
`agy` does not change its exit status (a missing `claude` or `codex` still does).

Refinement from a terminal (the CLI never calls a model; a host or a human does the thinking):

```bash
arena refine --task "Add rate limiting to the API"   # brief: repo facts, procedure, spec template;
                                                     # saves the request to ~/.arena/drafts/<id>.original.md
#   ...write the specification to spec.md (ask the user what cannot be settled from the code)...
arena start --players claude,codex --task-file spec.md \
            --original-task-file ~/.arena/drafts/<id>.original.md   # refined mode: original recorded
```

`--original-task` / `--original-task-file` is what distinguishes the modes: with it the session is
in refined mode (`task` is the specification, `originalTask` the request, and the runner prompt says
the task is an agreed specification to treat as authoritative); without it the session is in simple
mode. `arena doctor --json` reports the repository's default (`taskMode`).

Layout on disk:

```
~/.arena/
  sessions/<id>.json                 session state (task, taskMode, originalTask, players, results …)
  drafts/<id>.original.md            requests saved by `arena refine`
  <project>/<id>/
    task.md                          what the runners were given
    task.original.md                 the request before refinement (refined mode only)
    claude/  codex/                  worktrees (branches arena/<id>/<player>)
    logs/<player>.stdout.log …       runner output, exit codes
    results/<player>.diff …          diffs, status, verification logs, answers from arena ask,
                                      reviews from arena review (<player>.review-<n>.md, final.review-<n>.diff)
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
  agy:                     # Antigravity CLI
    command: agy
    extraArgs: ["--effort", "high"]   # model / label / env work as for the other built-ins
  gemini:                  # any CLI becomes a runner
    command: gemini
    label: Gemini
    args: ["--prompt", "{{prompt}}"]   # {{prompt}} {{promptFile}} {{task}} {{cwd}} {{branch}} {{arenaId}}
    askArgs: ["--resume", "{{sessionId}}", "--prompt", "{{prompt}}"]   # optional: enables arena ask
    env: { SOME_FLAG: "1" }

verify:
  test: bun test
  lint: bun run lint
  typecheck: false         # false disables a check
  timeout: 600             # seconds per command (also applies to setup)

setup: npm ci              # run in every fresh worktree before the runners start
# setup: [npm ci, npm run codegen]
# setup: false             # skip; default is lockfile detection (npm ci / pnpm / yarn / bun install)

refine: true               # default task mode for hosts: true = refine the request first, false = simple mode

integrations:
  orca: auto               # auto = only while running inside Orca; true = whenever the orca CLI exists; false = never
```

Fresh worktrees contain only tracked files, so without `setup` the runners and the verification step
would see no `node_modules`. If a setup command fails, the arena is aborted and its worktrees removed
(`arena start --no-setup` or `--setup "<cmd>"` override the config for one run).

If a custom runner's `args` does not reference `{{prompt}}` / `{{promptFile}}`, the prompt is piped
to stdin. The same applies to `askArgs`, which is only needed for custom runners: without it
`arena ask` reports that the runner cannot resume its conversation.

## Workspace apps (Orca)

Arena stays a plain CLI, but when it runs inside [Orca](https://github.com/stablyai/orca) it labels
its candidates there. Orca discovers the worktrees of a registered repository by itself; Arena only
adds the metadata, so each candidate shows up in the sidebar as `arena <id> · <Label>` with a status
line (`completed 4m12s · 5 files +120 −30 · test ✓ lint ✓ typecheck ✗ · selected`), moves across
the board columns (running → in-progress, finished → in-review, adopted → completed) and is grouped
under the worktree the arena was started from. Each candidate also gets a `<Label> (live)` terminal
that streams the runner's progress (`arena logs <id> <player> --follow`), so clicking a candidate
shows what it is doing instead of an empty shell. `arena clean` removes the worktrees and Orca drops
them.

```bash
arena doctor            # "workspace apps" shows whether the integration is active
arena open latest codex # open the candidate's changed files as diffs in Orca
arena logs latest claude --follow   # the same live view in any terminal
```

`--follow` prints a runner's stdout/stderr as it grows. Claude Code prints nothing in print mode until
it is done, so for Claude the live conversation transcript is shown instead (assistant text and one
line per tool call).

The integration is display-only and best effort: runners are still launched headless by Arena (so
`arena ask` / `arena review`, session pinning and runner isolation keep working), and a missing or
failing `orca` CLI only prints a warning. Superset has no way to show a worktree it did not create,
so there is no Superset integration yet.

## How runners are launched

Both players receive the same prompt: shared arena rules (work only in the current worktree, finish
the task completely, run tests, do not push) followed by the task verbatim. In refined mode the
task is the specification agreed with the user, and the rules add that it is authoritative: the
original request is not part of the prompt, so the runners cannot re-interpret it.

| Runner | Invocation |
|---|---|
| Claude | `claude -p --dangerously-skip-permissions --output-format text --settings '{"autoMemoryEnabled":false}'` (prompt on stdin) |
| Codex  | `codex exec -C <worktree> --sandbox workspace-write -c approval_policy="never" -o <results>/codex.last-message.md -` |
| Antigravity | `agy --add-dir <worktree> --dangerously-skip-permissions --print-timeout 12h --output-format stream-json -p=<prompt>` |

Headless runs cannot answer permission prompts, so Claude runs with permissions skipped; isolation
comes from the dedicated worktree, not from the permission system. Each runner is supervised by a
detached process that records the exit code, so `arena` commands can exit and come back later
(`arena wait`, `arena status`). `arena stop` kills the whole process group.

`agy` does not work in the process's current directory and cannot read the prompt from stdin, so the
worktree is passed with `--add-dir` and the prompt as a single `-p=<prompt>` argument. Its print mode
stops after 5 minutes by default, hence the explicit `--print-timeout`; the output is `stream-json`
because that is where the conversation id appears (the runner log is NDJSON, not plain text).

The variables `CLAUDECODE` / `CLAUDE_CODE_*` are stripped from runner environments so a Claude
runner started from inside Claude Code does not think it is nested. Claude Code keys its auto-memory
by repository, so a runner inside a worktree would otherwise read and write the host project's
memory; the Claude runner therefore passes `--settings '{"autoMemoryEnabled":false}'` and sets
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

### Asking a finished runner (`arena ask`)

The runners are one-shot processes, but their conversations survive them. `arena ask <id> <player>
"<question>"` resumes the runner's own conversation inside its worktree, so the answer comes from the
agent that wrote the code, with its full context, and prints it. Answers are saved under
`results/<player>.ask-<n>.md`, recorded in the session, and included in `arena compare` so a
reviewer sees the runner's own account next to the diff.

| Runner | Resume invocation |
|---|---|
| Claude | `claude -p --resume <session-id> --output-format text --permission-mode dontAsk --allowedTools <read-only list> --disallowedTools Edit,Write,MultiEdit,NotebookEdit --settings '{"autoMemoryEnabled":false}'` |
| Codex  | `codex exec resume -c sandbox_mode="read-only" -c approval_policy="never" <thread-id> -` |
| Antigravity | `agy --conversation <conversation-id> --add-dir <worktree> --sandbox --dangerously-skip-permissions --print-timeout 1h --output-format text -p=<prompt>` |

Asking is strictly read-only: the prompt says so, Claude is limited to inspection tools and Codex to
the read-only sandbox, and the worktree is fingerprinted before and after. If it changed anyway,
the answer is flagged and `arena collect --player <p>` should be re-run before trusting the earlier
results. Use `arena ask` to understand a candidate ("which requirement does this cover?", "why does
the test skip on Windows?"), not to request fixes: fixing is the host's job in the synthesis step.

**Antigravity is the exception:** `agy` has no read-only mode (in print mode even `--mode plan` and
`--sandbox` can write files), so for an `agy` player the read-only part of `arena ask` / `arena review`
is best effort: the prompt forbids changes and `--sandbox` is passed, but nothing enforces it. If the
worktree changed, the warning described above is what tells you.

The Claude conversation id is fixed at launch (`--session-id`). Codex has no such flag, so the thread
id is looked up after the run in `$CODEX_HOME/sessions` by worktree path and start time. Antigravity
has none either; its conversation id is read from the run's stdout log (`stream-json`). Sessions
whose worktrees were cleaned, and sessions started with a version before `arena ask` existed, cannot
be asked. Custom runners need `askArgs` in the configuration.

### Runner review of the final version (`arena review`)

Once a candidate is selected (a synthesis, or a candidate adopted as is), `arena review <id>` puts
the final version in front of **every runner**, in parallel, through the same read-only resume as
`arena ask`. Each reviewer gets the diff from the base commit to the selected worktree (including
uncommitted host edits), the worktree path, and a statement of how the final version relates to its
own candidate: "based on your candidate, edited by the host", "based on the other candidate", or
"adopted as is". The runner whose candidate lost is told explicitly that its own worktree is not the
final version. Reviewers must answer in a fixed format: a first line `VERDICT: approve` or
`VERDICT: request-changes`, then findings ordered `blocker` / `major` / `minor` / `nit` with file and
line. `--instructions "<text>"` appends a focus for the reviewers; `--players` limits who reviews.

Rounds are recorded in the session (`reviews[]`: target commit, per-runner verdict, answer paths),
saved under `results/<player>.review-<n>.md` with the reviewed diff in
`results/final.review-<n>.diff`, and summarized by `arena summary`. A runner that cannot be resumed
or times out is recorded as `not asked` / `timed out` instead of failing the round. The verdicts
are input for the host, not orders: in `/arena`, Claude Code verifies each blocker or major finding
against the code, fixes what it accepts in the selected worktree, re-runs verification, and runs a
second round when it changed something (two rounds at most). Rejected findings are shown to the
user with the reason. Runners never fix anything themselves.

## Project layout

```
src/
  arena.ts            CLI (thin command surface)
  core.ts             start / wait / stop / collect / select / commit / synthesize / adopt / clean
  refine.ts           task refinement brief + specification template (the host does the asking)
  host.ts             host model/effort detection and minimum-tier warnings (arena doctor)
  session.ts          JSON session state (zod schema)
  config.ts           config.yaml / .arena.yaml
  git/                repository, worktree, diff
  runners/            ArenaRunner interface, claude, codex, agy, custom, prompt
  process/            detached supervisor + spawn helpers
  verification/       detect + run test/lint/typecheck
  compare/            status, summary, markdown compare bundle
  integrations/       optional workspace-app mirrors (Orca); display-only, best effort
.claude/skills/arena/SKILL.md   Claude Code host
```

## Development

```bash
npm ci
npm run build                # dist/ is committed: rebuild and commit it with src/ changes
npm link                     # optional: expose this checkout as `arena`
npm run typecheck
npm test
npm run test:package          # pack, install into a disposable prefix, exercise CLI + skill
npm run dev -- doctor          # run from source without building
ARENA_HOME=/tmp/arena npm run dev -- run --players a,b --task "..."
```

## Distribution

From a maintainer checkout with Node.js and npm installed:

```bash
npm ci
npm run typecheck
npm test
npm run test:package
npm run build
npm pack                     # produces bon-arena-<version>.tgz
```

Release: bump the version (`npm version patch|minor`), run `npm run build` and commit `dist/`, then
`npm publish --access public --otp=<code>` (the account requires 2FA) and `git push --follow-tags`.
The `prepublishOnly` hook runs typecheck, unit tests and the package smoke test first. This
repository does not publish automatically. The generated `.tgz` can also be shared directly and
installed with `npm install -g ./bon-arena-<version>.tgz`.

## Not in v0.1

Automatic winner selection, cross-review, 3+ players, tournaments, cloud execution, web UI,
Superset adapter, delegating runner execution to Orca, MCP, PR creation, automatic merge, cost tracking.

## License

[MIT](LICENSE) — Copyright (c) 2026 Shuichi Suzuki.
