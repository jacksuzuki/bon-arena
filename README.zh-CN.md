# ccc-arena

[English](README.md) | [日本語](README.ja.md) | **简体中文**

让两个编码智能体在**各自独立的 git worktree** 中实现**同一个任务**，然后比较它们的产出（diff 统计、测试、lint、typecheck），并由你选择要采用的那个。

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

## 环境要求

- Node.js >= 22.18（或 Bun；代码只使用与 Node 兼容的 API）
- git
- 要参赛的 runner：PATH 中的 `claude`（Claude Code CLI）和/或 `codex`（Codex CLI）

## 安装

已发布到 npm：[`ccc-arena`](https://www.npmjs.com/package/ccc-arena)（需要 Node.js >= 22.18）：

```bash
npm install -g ccc-arena
arena install-skill
arena doctor         # 在你要工作的项目中运行
```

更新时运行 `npm install -g ccc-arena@latest`，然后执行 `arena install-skill --force`。卸载请运行 `npm uninstall -g ccc-arena`，如不再需要，可从 Claude Code 配置目录中删除 `skills/arena`。卸载包不会删除 arena 的会话和候选 worktree。如果安装后找不到 `arena`，请把 npm 的全局 bin 目录加入 PATH（macOS/Linux 为 `$(npm prefix -g)/bin`，Windows 为 `npm prefix -g`）。运行 arena 时需要 git，因为候选实现使用 git worktree。

### 免安装使用（npx）

```bash
npx ccc-arena doctor
npx ccc-arena run --players claude,codex --task "为 API 添加限流"
```

Claude Code 的 skill 从 PATH 调用 `arena`，找不到时会回退到 `npx ccc-arena`，但全局安装更快，并且可以不经确认直接使用 `/arena`。

### 从 GitHub 或 checkout 使用

编译后的 CLI（`dist/`）已提交到仓库，因此从仓库安装也不需要构建步骤：`npm install -g --install-links github:jacksuzuki/ccc-arena`（该参数是必需的：没有它，npm 10 会把 git 包安装为指向临时克隆的 symlink 并随即删除该克隆）或 `npx --package github:jacksuzuki/ccc-arena arena doctor`。可用 `#v0.1.0` 固定版本。开发用：

```bash
git clone https://github.com/jacksuzuki/ccc-arena.git
cd ccc-arena
npm ci
npm run build        # dist/ 已提交；修改 src/ 后需重新构建
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

Claude Code 会询问 Player 1 / Player 2，然后在启动任何东西之前**提炼任务**：阅读需求涉及的代码，找出 runner 否则只能靠猜的地方（范围、受影响文件、边界情况、命名、兼容性、测试），只就它自己无法决定的问题向你提问，并写出规格（目标、范围、需求、验收标准、约束、验证、决定事项）。你批准或编辑之后，两个玩家才会带着该规格在隔离的 worktree 中启动。runner 是无交互的，无法提问，所以正是这一步防止了它们各自做出不同的猜测。你的原始需求会与会话一起保存，并在 `arena compare` 中与规格并列显示。

要跳过提炼，可在命令行上预先选择 **simple 模式**，此时你的文本会原样传给 runner：

```
/arena task --simple 把 `Session` 类型重命名为 `ArenaSession`
/arena task-simple 把 `Session` 类型重命名为 `ArenaSession`      # 等价写法
```

`/arena task <text>`（或纯文本）默认会提炼；不带参数的 `/arena` 会与玩家一起询问模式。`.arena.yaml` 中的 `refine: false` 可把仓库默认改为 simple 模式，`task --refine` 强制提炼，`/arena -- <text>` 可发送恰好以关键字开头的文本。提炼期间不会启动任何东西；在任何 worktree 存在之前，你都可以编辑规格或取消。确认步骤不会再次提供模式选择。

runner 完成后，Claude Code 会等待、运行验证、显示摘要，并**始终先给出比较**：事实、逐项判断、推荐的基底以及另一候选做得更好的地方。之后才询问下一步。推荐选项是 **Synthesize**：以更强的候选为基底，在该候选的 worktree 中融入另一方的优点，重新运行验证，并把结果提交到候选分支。你也可以原样采用任一候选。合并到你的分支（`arena adopt`）只在你明确要求时进行，并且永远不会 push。

## 在终端中使用

```bash
arena run --players claude,codex --task "为 API 添加限流"   # simple 模式：文本原样传给 runner
# 或分步执行
arena start --players claude,codex --task-file task.md
arena wait latest
arena collect latest
arena compare latest        # 供 LLM 或人工审阅的 markdown 包
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
```

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
    results/<player>.diff …          diff、status、验证日志
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
  gemini:                  # 任何 CLI 都可以成为 runner
    command: gemini
    label: Gemini
    args: ["--prompt", "{{prompt}}"]   # {{prompt}} {{promptFile}} {{task}} {{cwd}} {{branch}} {{arenaId}}
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

如果自定义 runner 的 `args` 没有引用 `{{prompt}}` / `{{promptFile}}`，提示词会通过 stdin 传入。

## runner 的启动方式

两个玩家收到相同的提示词：共享的 arena 规则（只在当前 worktree 内工作、完整完成任务、运行测试、不要 push），然后是原样的任务。在 refined 模式下，任务就是与用户商定的规格，规则中会补充说明它是权威的：原始需求不在提示词中，因此 runner 无法重新解释它。

| Runner | 调用方式 |
|---|---|
| Claude | `claude -p --dangerously-skip-permissions --output-format text --settings '{"autoMemoryEnabled":false}'`（提示词通过 stdin） |
| Codex  | `codex exec -C <worktree> --sandbox workspace-write -c approval_policy="never" -o <results>/codex.last-message.md -` |

无交互运行无法回答权限确认，因此 Claude 以跳过权限的方式运行；隔离来自专用 worktree，而不是权限系统。每个 runner 由一个分离的 supervisor 进程监管并记录退出码，因此 `arena` 命令可以退出后再回来（`arena wait`、`arena status`）。`arena stop` 会终止整个进程组。

runner 的环境中会去掉 `CLAUDECODE` / `CLAUDE_CODE_*` 变量，这样从 Claude Code 内部启动的 Claude runner 不会误以为自己是嵌套运行。Claude Code 的 auto-memory 以仓库为键，worktree 中的 runner 否则会读写宿主项目的记忆；因此 Claude runner 会传入 `--settings '{"autoMemoryEnabled":false}'` 并设置 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。

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
  runners/            ArenaRunner 接口, claude, codex, custom, prompt
  process/            分离的 supervisor + spawn 辅助
  verification/       检测并运行 test/lint/typecheck
  compare/            status, summary, markdown 比较包
.claude/skills/arena/SKILL.md   Claude Code 宿主
```

## 开发

```bash
npm ci
npm run build                # dist/ 已提交：修改 src/ 后重新构建并一起提交
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
npm run build
npm pack                     # 生成 ccc-arena-<version>.tgz
```

发布流程：提升版本（`npm version patch|minor`），运行 `npm run build` 并提交 `dist/`，然后执行 `npm publish --access public --otp=<code>`（账号需启用 2FA），再 `git push --follow-tags`。`prepublishOnly` 钩子会先运行 typecheck、单元测试和包冒烟测试。本仓库不会自动发布。生成的 `.tgz` 也可以直接分享，用 `npm install -g ./ccc-arena-<version>.tgz` 安装。

## v0.1 不包含

自动判定胜者、交叉评审、3 个以上玩家、锦标赛、云端执行、Web UI、Superset/Orca 适配器、MCP、创建 PR、自动合并、成本统计。

## 许可证

[MIT](LICENSE) — Copyright (c) 2026 Shuichi Suzuki.
