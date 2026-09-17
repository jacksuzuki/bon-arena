# ccc-arena

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
- Runners you want to race: `claude` (Claude Code CLI) and/or `codex` (Codex CLI) in PATH

## Install (no git clone required)

Install a published npm release globally, then install the optional Claude Code skill:

```bash
npm install -g ccc-arena
arena install-skill
arena doctor         # run in the project you want to work on
```

The npm command above requires `ccc-arena` to have been published to your registry. For an
unpublished build, install a release archive supplied by the maintainer instead:

```bash
npm install -g ./ccc-arena-0.1.0.tgz
arena install-skill
```

Both methods provide the `arena` command without a checkout or a local TypeScript build. git is
still required when running arenas because candidate implementations use git worktrees.
If `arena` is not found after installation, add the npm global bin directory to PATH
(`$(npm prefix -g)/bin` on macOS/Linux, `npm prefix -g` on Windows).

`arena install-skill` copies the bundled skill to `~/.claude/skills/arena/SKILL.md`; no symlink or
repository path is needed. Restart Claude Code after installation. It respects `CLAUDE_CONFIG_DIR`,
or use `arena install-skill --config-dir /path/to/claude-config`. Repeating it is safe: identical
content is left alone, and different content is preserved unless you pass `--force`. Use `--force`
to update the skill after upgrading or to replace the old checkout-based symlink.

Once an npm release is published, you can also run the CLI without a global installation:

```bash
npx --package ccc-arena arena doctor
npx --package ccc-arena arena run --players claude,codex --task "Add rate limiting"
```

The Claude Code skill invokes `arena` from PATH, so use the global installation for `/arena`.

To update, repeat the global install command with the new package/version, then run
`arena install-skill --force`. To uninstall, run `npm uninstall -g ccc-arena` and remove the
installed `skills/arena` directory from your Claude Code config directory if no longer needed.
Arena sessions and candidate worktrees are not removed by uninstalling the package.

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
also adopt either candidate as is. Merging into your branch (`arena adopt`) happens only when you
say so, and nothing is ever pushed.

## Use from a terminal

```bash
arena run --players claude,codex --task "Add rate limiting to the API"   # simple mode: text goes to the runners verbatim
# or step by step
arena start --players claude,codex --task-file task.md
arena wait latest
arena collect latest
arena compare latest        # markdown bundle for an LLM or human reviewer
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
```

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
  timeout: 600             # seconds per command (also applies to setup)

setup: npm ci              # run in every fresh worktree before the runners start
# setup: [npm ci, npm run codegen]
# setup: false             # skip; default is lockfile detection (npm ci / pnpm / yarn / bun install)

refine: true               # default task mode for hosts: true = refine the request first, false = simple mode
```

Fresh worktrees contain only tracked files, so without `setup` the runners and the verification step
would see no `node_modules`. If a setup command fails, the arena is aborted and its worktrees removed
(`arena start --no-setup` or `--setup "<cmd>"` override the config for one run).

If a custom runner's `args` does not reference `{{prompt}}` / `{{promptFile}}`, the prompt is piped
to stdin.

## How runners are launched

Both players receive the same prompt: shared arena rules (work only in the current worktree, finish
the task completely, run tests, do not push) followed by the task verbatim. In refined mode the
task is the specification agreed with the user, and the rules add that it is authoritative: the
original request is not part of the prompt, so the runners cannot re-interpret it.

| Runner | Invocation |
|---|---|
| Claude | `claude -p --dangerously-skip-permissions --output-format text --settings '{"autoMemoryEnabled":false}'` (prompt on stdin) |
| Codex  | `codex exec -C <worktree> --sandbox workspace-write -c approval_policy="never" -o <results>/codex.last-message.md -` |

Headless runs cannot answer permission prompts, so Claude runs with permissions skipped; isolation
comes from the dedicated worktree, not from the permission system. Each runner is supervised by a
detached process that records the exit code, so `arena` commands can exit and come back later
(`arena wait`, `arena status`). `arena stop` kills the whole process group.

The variables `CLAUDECODE` / `CLAUDE_CODE_*` are stripped from runner environments so a Claude
runner started from inside Claude Code does not think it is nested. Claude Code keys its auto-memory
by repository, so a runner inside a worktree would otherwise read and write the host project's
memory; the Claude runner therefore passes `--settings '{"autoMemoryEnabled":false}'` and sets
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

## Project layout

```
src/
  arena.ts            CLI (thin command surface)
  core.ts             start / wait / stop / collect / select / commit / synthesize / adopt / clean
  refine.ts           task refinement brief + specification template (the host does the asking)
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
npm ci                       # builds dist/ via prepare
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
npm pack                     # builds via prepare; produces ccc-arena-<version>.tgz
```

Share the generated `.tgz` directly or attach it to a release. Recipients install it with
`npm install -g /path/to/ccc-arena-<version>.tgz`; they do not need the source checkout or dev
dependencies. The archive includes compiled JavaScript and the Claude Code skill. npm downloads
the runtime dependencies during installation, so this is not an offline bundle.

Alternatively, a maintainer with registry access can run `npm publish` (after choosing an available
package name/version). The `prepublishOnly` hook runs typecheck, unit tests and the package smoke
test before publication. This repository does not publish automatically.

## Not in v0.1

Automatic winner selection, cross-review, 3+ players, tournaments, cloud execution, web UI,
Superset/Orca adapters, MCP, PR creation, automatic merge, cost tracking.
