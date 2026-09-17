# bon-arena

[English](../README.md) | [日本語](README.ja.md) | **简体中文**

让两到三个编码智能体在**各自独立的 git worktree** 中实现**同一个任务**，然后比较它们的产出（diff 统计、测试、lint、typecheck），并由你选择要采用的那个。

```
Claude Code (/arena)
      ↓
  与你一起把需求提炼成可一次性实现的规格   (用 "simple" 可跳过)
      ↓
  Arena Core  ──┬── worktree A ── Claude Code CLI
                └── worktree B ── Codex CLI
      ↓
  收集 (diff, test, lint, typecheck) → 比较 → 由你决定
```

Arena Core 是一个小巧、与宿主无关的 CLI。Claude Code 的 `/arena` skill 是第一个宿主；其他宿主（Codex、独立使用、其他 harness）也可以驱动同一个 CLI。

> **安全：** 内置 runner 以完全权限运行（没有确认提示，也没有任何东西能限制它们）。请只用于你信任的代码，或在容器、虚拟机中运行。见[安全](#安全)。

## 环境要求

- Node.js >= 22.18（或 Bun；代码只使用与 Node 兼容的 API）
- git
- 要参赛的 runner 需在 PATH 中：`claude`（Claude Code CLI）、`codex`（Codex CLI）和/或 `agy`（Antigravity CLI）。这三个是内置 runner，其他 CLI 可以通过配置添加

## 安装

已发布到 npm：[`bon-arena`](https://www.npmjs.com/package/bon-arena)（需要 Node.js >= 22.18）：

```bash
npm install -g bon-arena
arena install-skill
arena doctor         # 在你要工作的项目中运行
```

更新时运行 `npm install -g bon-arena@latest`，然后执行 `arena install-skill --force`。卸载请运行 `npm uninstall -g bon-arena`，如不再需要，可从 Claude Code 配置目录中删除 `skills/arena`。卸载包不会删除 arena 的会话和候选 worktree。如果安装后找不到 `arena`，请把 npm 的全局 bin 目录加入 PATH（macOS/Linux 为 `$(npm prefix -g)/bin`，Windows 为 `npm prefix -g`）。运行 arena 时需要 git，因为候选实现使用 git worktree。

### 免安装使用（npx）

```bash
npx bon-arena doctor
npx bon-arena run --players claude,codex --task "为 API 添加限流"
```

Claude Code 的 skill 从 PATH 调用 `arena`，找不到时会回退到 `npx bon-arena`，但全局安装更快，并且可以不经确认直接使用 `/arena`。

### 从 checkout 使用

编译后的 CLI（`dist/`）是构建产物，不提交到仓库；`npm ci` 时会（通过 `prepare` 脚本）自动构建。正式版本请按上文从 npm 安装。开发用：

```bash
git clone https://github.com/jacksuzuki/bon-arena.git
cd bon-arena
npm ci               # 安装依赖并构建 dist/
npm run build        # 若已 link 此 checkout，修改 src/（或 pull）后需重新构建
npm link             # 把这个 checkout 暴露为 arena 命令
arena install-skill
```

`arena install-skill` 会把内置 skill 复制到 `~/.claude/skills/arena/SKILL.md`；不需要 symlink 或仓库路径。安装后请重启 Claude Code。它遵循 `CLAUDE_CONFIG_DIR`，也可以用 `arena install-skill --config-dir /path/to/claude-config` 指定。重复执行是安全的：内容相同时不做任何改动，内容不同时除非传入 `--force`，否则保留现有文件。升级后更新 skill，或替换旧的基于 checkout 的 symlink 时，请使用 `--force`。

## 宿主模型建议

`/arena` 的宿主承担判断密集的工作：把需求提炼为规格、核实 runner 的声明、合成最终版本。请在 Mythos 级模型（Fable 5.1）上以 effort **high** 或更高运行；**最低要求是 Opus 5 的 medium**。runner 的模型可独立选择，可以更便宜。

`arena doctor` 会检测 Claude Code 中当前运行的宿主（会话 transcript + `CLAUDE_EFFORT`），低于最低要求时打印 `⚠` 警告；skill 会在开始前转达这些警告：

```
host
  harness    Claude Code (session c8e40442)
  model      claude-fable-5-1  [session transcript]
  effort     high  [CLAUDE_EFFORT]
```

在 Claude Code 之外，宿主会被报告为未检测到，且不给出警告。

## 在 Claude Code 中使用

在任意 git 仓库中：

```
/arena 用 Better Auth 替换手写的会话代码
```

Claude Code 会询问 Player 1 / Player 2 以及可选的 Player 3，然后在启动任何东西之前**提炼任务**：找出 runner 对**你想要什么**只能靠猜的地方（范围、边界情况、面向用户的名称、兼容性），只就它自己无法决定的问题向你提问，并写出规格（目标、背景、范围、需求、以可观察行为表述的验收标准、约束、验证、决定事项，以及留给实现者的部分）。宿主有意止步于此：深入调查代码和设计方案正是 runner 相互竞争的部分，宿主替它们做的任何事都会连同错误一起被所有候选共享。宿主顺带得到的实现层面发现写入简短的 “Notes (unverified)”，并告知 runner 应核实而非照办。你批准或编辑之后，两个玩家才会带着该规格在隔离的 worktree 中启动。runner 是无交互的，无法提问，所以正是这一步防止了它们各自做出不同的猜测。你的原始需求会与会话一起保存，并在 `arena compare` 中与规格并列显示。

要跳过提炼，可在命令行上预先选择 **simple 模式**，此时你的文本会原样传给 runner：

```
/arena task --simple 把 `Session` 类型重命名为 `ArenaSession`
/arena task-simple 把 `Session` 类型重命名为 `ArenaSession`      # 等价写法
```

`/arena task <text>`（或纯文本）默认会提炼；不带参数的 `/arena` 会与玩家一起询问模式。`.arena.yaml` 中的 `refine: false` 可把仓库默认改为 simple 模式，`task --refine` 强制提炼，`/arena -- <text>` 可发送恰好以关键字开头的文本。提炼期间不会启动任何东西；在任何 worktree 存在之前，你都可以编辑规格或取消。确认步骤不会再次提供模式选择。

runner 完成后，Claude Code 会等待、运行验证、显示摘要，并**始终先给出比较**：事实、逐项判断、推荐的基底以及另一候选做得更好的地方。之后才询问下一步。推荐选项是 **Synthesize**：以更强的候选为基底，在该候选的 worktree 中融入另一方的优点，重新运行验证，并把结果提交到候选分支。你也可以原样采用任一候选。在询问是否合并之前，Claude Code 会让**所有 runner 都审阅最终版本**（`arena review`）：每个 runner 以只读方式恢复自己的会话，查看最终 diff，并给出结论和发现；Claude Code 会核实这些发现，修复它认可的，并把拒绝的连同理由一起展示给你。合并到你的分支（`arena adopt`）只在你明确要求时进行，并且永远不会 push。

## 在终端中使用

```bash
arena run --players claude,codex --task "为 API 添加限流"   # simple 模式：文本原样传给 runner
arena run --players claude,agy --task "为 API 添加限流"     # 内置 runner 任选：claude、codex、agy（Antigravity）
arena run --players claude,codex,agy --task "为 API 添加限流"   # 三个玩家；同一 runner 可重复（claude,claude → claude、claude-2）
# 或分步执行
arena start --players claude,codex --task-file task.md
arena wait latest
arena collect latest
arena compare latest        # 供 LLM 或人工审阅的 markdown 包
arena ask latest codex "为什么重试上限是 2？"   # 以只读方式恢复 runner 自己的会话并提问
arena select latest codex
arena commit latest codex   # 把 worktree 的改动快照到候选分支
arena adopt latest          # 把所选分支合并到当前分支 (--ff / --squash)
arena clean latest          # 删除 worktree；保留所选分支

# 由宿主驱动的收尾（在 /arena 中由 Claude Code 代劳）
arena synthesize latest codex          # 快照 + 选定基底，打印另一候选的 diff
#   ...在 codex 的 worktree 中编辑...
arena collect latest --player codex    # 重新验证
arena commit latest codex -m "arena: synthesis"
arena finish latest
arena review latest                    # 每个 runner 审阅最终版本（只读、并行）
arena review latest --instructions "重点看重试路径"   # 可选的提示；--players codex 可限定审阅者
```

省略 `--players` 时默认仍为 `claude,codex`。`arena doctor` 会列出全部三个内置 runner；缺少 `agy` 不影响其退出码（缺少 `claude` 或 `codex` 时仍为 1）。

在终端中提炼（CLI 从不调用模型；思考由宿主或人来完成）：

```bash
arena refine --task "为 API 添加限流"   # 简报：仓库信息、流程、规格模板；
                                       # 把需求保存到 ~/.arena/drafts/<id>.original.md
#   ...把规格写入 spec.md（无法从代码确定的问题去问用户）...
arena start --players claude,codex --task-file spec.md \
            --original-task-file ~/.arena/drafts/<id>.original.md   # refined 模式：记录原始需求
```

区分模式的是 `--original-task` / `--original-task-file`：带上它，会话处于 refined 模式（`task` 是规格，`originalTask` 是需求，runner 提示词会说明该任务是已商定的规格，应视为权威）；不带它，会话处于 simple 模式。`arena doctor --json` 会报告仓库的默认值（`taskMode`）。

磁盘布局：

```
~/.arena/
  sessions/<id>.json                 会话状态 (task, taskMode, originalTask, players, results …)
  drafts/<id>.original.md            `arena refine` 保存的需求
  <project>/<id>/
    task.md                          交给 runner 的内容
    task.original.md                 提炼前的需求（仅 refined 模式）
    claude/  codex/                  worktree（分支 arena/<id>/<player>）
    logs/<player>.stdout.log …       runner 输出、退出码
    results/<player>.diff …          diff、status、验证日志、arena ask 的回答、
                                      arena review 的审阅（<player>.review-<n>.md、final.review-<n>.diff）
```

## 配置

`~/.config/arena/config.yaml`（用户级）与 `.arena.yaml`（仓库级；优先）。CLI 参数优先于两者；从 `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` 自动检测是兜底方案。

```yaml
runners:
  claude:
    command: claude
    model: opus            # 可选
    extraArgs: []          # 追加到内置调用之后
  codex:
    command: codex
  agy:                     # Antigravity CLI
    command: agy
    extraArgs: ["--effort", "high"]   # model / label / env 与其他内置 runner 相同
  gemini:                  # 任何 CLI 都可以成为 runner
    command: gemini
    label: Gemini
    args: ["--prompt", "{{prompt}}"]   # {{prompt}} {{promptFile}} {{task}} {{cwd}} {{branch}} {{arenaId}}
    askArgs: ["--resume", "{{sessionId}}", "--prompt", "{{prompt}}"]   # 可选：启用 arena ask
    env: { SOME_FLAG: "1" }

verify:
  test: bun test
  lint: bun run lint
  typecheck: false         # false 表示禁用该检查
  timeout: 600             # 每条命令的秒数（同样适用于 setup）

setup: npm ci              # runner 启动前在每个新 worktree 中执行
# setup: [npm ci, npm run codegen]
# setup: false             # 跳过；默认按 lockfile 检测 (npm ci / pnpm / yarn / bun install)

refine: true               # 宿主的默认任务模式：true = 先提炼需求，false = simple 模式
```

新的 worktree 只包含被跟踪的文件，因此没有 `setup` 时，runner 和验证步骤都看不到 `node_modules`。如果 setup 命令失败，arena 会中止并删除其 worktree（`arena start --no-setup` 或 `--setup "<cmd>"` 可对单次运行覆盖配置）。

如果自定义 runner 的 `args` 没有引用 `{{prompt}}` / `{{promptFile}}`，提示词会通过 stdin 传入。 `askArgs` 也一样，且只有自定义 runner 需要它；未设置时 `arena ask` 会报告该 runner 无法恢复会话。

## 工作区应用集成 (Orca)

Arena 仍是独立的 CLI，但在 [Orca](https://github.com/stablyai/orca) 中运行时会把候选同步到 Orca。
Orca 会自动发现已注册仓库的 worktree，Arena 只负责补充元数据：每个候选在侧边栏显示为
`arena <id> · <标签>`，附带状态行（`completed 4m12s · 5 files +120 −30 · test ✓ lint ✓ typecheck ✗ · selected`），
看板列随状态移动（运行中 → in-progress，完成 → in-review，已采用 → completed），并归在启动 arena 的
worktree 之下。`arena review` / `arena ask` 运行期间，状态行以 `⏳ reviewing the final version (round 1)` /
`⏳ answering a question` 开头，结束后在末尾附上结论（`review #1: approve`）。每个候选还会得到一个 `<标签> (live)` 终端，实时输出 runner 的进度
（`arena logs <id> <player> --follow`），点击候选时不再是空 shell。`arena clean` 删除 worktree 后，Orca 中也随之消失。

```bash
arena doctor            # “workspace apps” 显示集成是否生效
arena open latest codex # 在 Orca 中以 diff 方式打开候选的改动文件
arena logs latest claude --follow   # 在任意终端查看同样的实时输出
```

`--follow` 会持续输出 runner 的 stdout/stderr。Claude Code 在 print 模式下结束前没有任何输出，
因此对 Claude 改为显示实时会话 transcript（助手文本以及每次工具调用一行）。

如果 Orca 中该项目设置为隐藏外部 worktree，候选虽已打上标签，却会收在侧边栏折叠的 “Hiding … discovered worktrees” 行里；
此时 `arena doctor` 和 `arena start` 会输出 `note:`。展开该行，或在项目设置中改为显示外部 worktree。

配置项为 `integrations.orca: auto | true | false`（默认 `auto` = 仅在 Orca 内运行时启用）。该集成只负责展示，
且为 best effort：runner 仍由 Arena 以 headless 方式启动，`arena ask` / `arena review` 与 runner 隔离不受影响；
`orca` CLI 缺失或失败时只会输出警告。Superset 无法显示非自身创建的 worktree，因此暂无 Superset 集成。

## runner 的启动方式

所有玩家收到相同的提示词：共享的 arena 规则（只在当前 worktree 内工作、完整完成任务、运行测试、不要 push），然后是原样的任务。在 refined 模式下，任务就是与用户商定的规格，规则中会补充说明它是权威的：原始需求不在提示词中，因此 runner 无法重新解释它。

| Runner | 调用方式 |
|---|---|
| Claude | `claude -p --dangerously-skip-permissions --output-format text --settings '{"autoMemoryEnabled":false}'`（提示词通过 stdin） |
| Codex  | `codex exec -C <worktree> --dangerously-bypass-approvals-and-sandbox -o <results>/codex.last-message.md -` |
| Antigravity | `agy --add-dir <worktree> --dangerously-skip-permissions --print-timeout 12h --output-format stream-json -p=<prompt>` |

无交互运行无法回答权限确认，因此所有内置 runner 都以跳过权限、不受任何限制的方式运行（见[安全](#安全)）。每个 runner 由一个分离的 supervisor 进程监管并记录退出码，因此 `arena` 命令可以退出后再回来（`arena wait`、`arena status`）。`arena stop` 会终止整个进程组。

`agy` 不在进程的当前目录中工作，也无法从 stdin 读取提示词，因此 worktree 通过 `--add-dir` 传入，提示词作为单个 `-p=<prompt>` 参数传入。它的 print 模式默认 5 分钟后中止，所以显式指定 `--print-timeout`；输出使用 `stream-json`，因为会话 id 出现在其中（runner 的日志是 NDJSON，而不是纯文本）。

runner 的环境中会去掉 `CLAUDECODE` / `CLAUDE_CODE_*` 变量，这样从 Claude Code 内部启动的 Claude runner 不会误以为自己是嵌套运行。Claude Code 的 auto-memory 以仓库为键，worktree 中的 runner 否则会读写宿主项目的记忆；因此 Claude runner 会传入 `--settings '{"autoMemoryEnabled":false}'` 并设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。

### 安全

**内置 runner 以完全权限运行：没有确认提示，也没有任何东西能限制它们。** runner 可以读取、修改和执行你的用户账户能做的任何事，包括 worktree 之外的文件、你的凭据和网络。专用 worktree 只是把各候选的改动分开，并不是安全边界；提示词里的规则（“只在 worktree 内工作”“不要 push”）是指示，而不是强制。

这是有意的设计。无交互运行无法回答权限确认，因此完全权限的替代方案是一个 agent 无法请求离开的沙箱，而处于这种状态的 agent 在 dev server、浏览器和包存储上受阻时，会直接放弃而不去检查自己的实现。此外，所有玩家必须在相同条件下竞争：在不受限制的 runner 旁边只把其中一个放进沙箱，什么也保护不了，只会让它处于劣势。

Antigravity 只是机制上的例外，效果相同。`agy` 有一个终端沙箱，无法通过启动参数关闭：即使在无交互运行中，它也遵循 `~/.gemini/antigravity-cli/settings.json` 里的 `enableTerminalSandbox`。开启时，`agy` 先在沙箱内执行每条命令，但可以在沙箱外重新执行被拦截的命令，而这个请求同样会被 `--dangerously-skip-permissions` 批准。因此它只是多一次失败的尝试，能触及的范围与其他 runner 相同。Arena 不会修改你的 `agy` 设置。

请把 `arena run` 当作你自己以 “yolo” 模式同时运行三个 agent：

- 只用于你信任的仓库、依赖和任务。agent 读取的内容（代码、issue、网页）可能带有提示词注入。
- 对不信任的内容，请在容器或虚拟机中运行 Arena。
- `arena doctor` 以及每次 `arena start` / `arena run` 都会显示提醒。

如果仍想限制某个 runner，可以用自己的参数定义一个[自定义 runner](#配置)（例如用另一个 id 运行 `codex exec --sandbox workspace-write …`），但这样比较就不再是同等条件。`arena ask` 和 `arena review` 不同：它们以只读方式恢复已结束的会话（见下文）。

### 向已完成的 runner 提问（`arena ask`）

runner 是一次性进程，但它们的会话在进程结束后仍然保留。`arena ask <id> <player> "<问题>"` 会在 worktree 内恢复 runner 自己的会话，因此回答来自写下这些代码的那个 agent，并带着它的完整上下文。回答保存在 `results/<player>.ask-<n>.md`，记录到会话中，并包含在 `arena compare` 里，审阅者可以在 diff 旁边看到 runner 自己的说明。

| Runner | 恢复命令 |
|---|---|
| Claude | `claude -p --resume <session-id> --output-format text --permission-mode dontAsk --allowedTools <只读工具列表> --disallowedTools Edit,Write,MultiEdit,NotebookEdit --settings '{"autoMemoryEnabled":false}'` |
| Codex  | `codex exec resume -c sandbox_mode="read-only" -c approval_policy="never" <thread-id> -` |
| Antigravity | `agy --conversation <conversation-id> --add-dir <worktree> --sandbox --dangerously-skip-permissions --print-timeout 1h --output-format text -p=<prompt>` |

提问是严格只读的：提示词会如此说明，Claude 被限制为只能使用查看类工具，Codex 使用只读沙箱，并且会在前后比较 worktree 的指纹。如果仍然发生了改动，回答会被标记，在信任之前的结果前应重新运行 `arena collect --player <p>`。`arena ask` 用来理解候选（"这个改动对应规格的哪一条？""为什么这个测试在 Windows 上跳过？"），而不是用来要求修复：修复由宿主在 synthesis 步骤完成。

**Antigravity 是例外：**`agy` 没有只读模式（在 print 模式下，即使 `--mode plan` 或 `--sandbox` 也能写文件），因此对 `agy` 的 player，`arena ask` / `arena review` 的只读只是尽力而为：提示词禁止改动并附加 `--sandbox`，但无法强制。如果 worktree 发生了变化，就会出现上述警告。

Claude 的会话 id 在启动时固定（`--session-id`）。Codex 没有这样的参数，因此在运行结束后按 worktree 路径和开始时间在 `$CODEX_HOME/sessions` 中查找 thread id。Antigravity 同样没有该参数，会话 id 从运行时的 stdout 日志（`stream-json`）中读取。已 clean 的会话，以及在 `arena ask` 出现之前的版本启动的会话，无法提问。自定义 runner 需要在配置中提供 `askArgs`。

### 让 runner 审阅最终版本（`arena review`）

选定候选之后（无论是 synthesis 的结果还是原样采用的候选），`arena review <id>` 会通过与 `arena ask` 相同的只读恢复方式，让**每个 runner** 并行审阅最终版本。每个审阅者会收到从基准提交到所选 worktree 的 diff（包含宿主未提交的编辑）、worktree 路径，以及最终版本与它自己候选的关系说明："基于你的候选，由宿主编辑"、"基于另一候选"或"原样采用"。落选的 runner 会被明确告知它自己的 worktree 不是最终版本。回答必须使用固定格式：第一行是 `VERDICT: approve` 或 `VERDICT: request-changes`，然后是按 `blocker` / `major` / `minor` / `nit` 排序、附文件和行号的发现。`--instructions "<文本>"` 为审阅者附加关注点；`--players` 限定审阅者。

每一轮都记录在会话中（`reviews[]`：目标提交、每个 runner 的结论、回答路径），回答保存在 `results/<player>.review-<n>.md`，被审阅的 diff 在 `results/final.review-<n>.diff`，`arena summary` 会显示结论。无法恢复或超时的 runner 会被记为 `not asked` / `timed out`，而不会让整轮失败。结论是给宿主的输入，不是命令：在 `/arena` 中，Claude Code 会对照代码核实每个 blocker 或 major 发现，在所选 worktree 中修复它认可的，重新运行验证，并在改动了代码时再跑一轮（最多两轮）。被拒绝的发现会连同理由展示给用户。runner 自己永远不会做修改。

## 项目结构

```
src/
  arena.ts            CLI（薄薄的命令层）
  core.ts             start / wait / stop / collect / select / commit / synthesize / adopt / clean
  refine.ts           任务提炼简报 + 规格模板（提问由宿主完成）
  host.ts             宿主模型/effort 检测与最低等级警告 (arena doctor)
  session.ts          JSON 会话状态（zod schema）
  config.ts           config.yaml / .arena.yaml
  git/                repository, worktree, diff
  runners/            ArenaRunner 接口, claude, codex, agy, custom, prompt
  process/            分离的 supervisor + spawn 辅助
  verification/       检测并运行 test/lint/typecheck
  compare/            status, summary, markdown 比较包
.claude/skills/arena/SKILL.md   Claude Code 宿主
```

## 开发

```bash
npm ci
npm run build                # dist/ 不纳入 git；link 的 checkout 运行的是 dist/，修改 src/ 后需重新构建
npm link                     # 可选：把这个 checkout 暴露为 `arena`
npm run typecheck
npm test
npm run test:package          # 打包，安装到一次性 prefix，测试 CLI + skill
npm run dev -- doctor          # 不构建，直接从源码运行
ARENA_HOME=/tmp/arena npm run dev -- run --players a,b --task "..."
```

## 分发

在安装了 Node.js 和 npm 的维护者 checkout 中：

```bash
npm ci
npm run typecheck
npm test
npm run test:package
npm pack                     # 生成 bon-arena-<version>.tgz
```

发布流程：提升版本（`npm version patch|minor`），然后执行 `npm publish --access public --otp=<code>`（账号需启用 2FA），再 `git push --follow-tags`。`prepare` 钩子会把 `dist/` 构建进包中，`prepublishOnly` 钩子会先运行 typecheck、单元测试和包冒烟测试。本仓库不会自动发布。生成的 `.tgz` 也可以直接分享，用 `npm install -g ./bon-arena-<version>.tgz` 安装。

## v0.1 不包含

自动判定胜者、交叉评审、`/arena` 中 4 个以上玩家、锦标赛、云端执行、Web UI、Superset 适配器、将 runner 执行委托给 Orca、MCP、创建 PR、自动合并、成本统计。

## 许可证

[MIT](LICENSE) — Copyright (c) 2026 Shuichi Suzuki.
