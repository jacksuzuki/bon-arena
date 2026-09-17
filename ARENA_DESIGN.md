# Arena CLI 設計方針

## 1. 目的

Claude Code 内の Arena Skill から複数のコーディングエージェントを同一タスクで競わせ、それぞれ独立した Git worktree 上で実装させ、結果を比較できる Arena runtime を作る。

最初の MVP では Claude Code をメインのハーネス（orchestrator / host）として利用する。

- Claude Code Skill から Arena を起動
- Claude
- Codex CLI
- 2エージェント対戦
- Git worktree による完全分離
- Claude Code 内での対話
- 実行結果・diff・テスト結果の収集
- 人間が最終採用を判断

Arena Core 自体は Claude Code に依存させすぎない。

将来的には standalone CLI に加えて、Codex、agy など別のコーディングハーネスからも Arena Core を起動・制御できる構造にする。

Superset / Orca / Claude Mods には依存しない。

将来的にそれらへ統合できるよう、core と harness integration を分離する。

---

## 2. 基本方針

### 2.1 Arena 自体は汎用ツールにする

Arena の本質は以下。

1. 対戦する runner を選ぶ
2. 共通タスクを定義する
3. runner ごとに Git worktree を作る
4. 各 runner を独立実行する
5. 完了を待つ
6. 実行結果を収集する
7. diff / test / lint / typecheck などを比較する
8. ユーザーが採用案を選ぶ

Superset や Orca 固有機能を core に持ち込まない。

将来的には以下のような adapter を追加可能にする。

```text
arena
├── core
├── runners
│   ├── claude
│   ├── codex
│   ├── gemini
│   └── custom
└── integrations
    ├── standalone
    ├── superset
    └── orca
```

---

## 3. MVP のスコープ

### やる

- Claude Code の `/arena` Skill
- Claude Code 内での対話式 runner 選択
- Claude runner
- Codex CLI runner
- Git worktree 自動生成
- 同一 task を双方へ渡す
- 並列実行
- status 表示
- stdout / stderr 保存
- git diff 収集
-変更ファイル数の集計
-追加/削除行数の集計
- test command 実行
- lint / typecheck command 実行
-比較用 summary の生成
-ユーザーによる採用候補選択

### やらない

- 自動 merge
- 勝者の完全自動決定
- Superset API 依存
- Orca API 依存
- Claude Mods
- MCP server
- Web UI
- DB
- Gemini / OpenCode 対応
- 3体以上の tournament
- cloud execution

---

## 4. Claude Code UX

### 起動

MVP では standalone CLI ではなく、Claude Code 内の Arena Skill から起動する。

```text
/arena
```

Claude Code が Arena のメインハーネスとして、対話・worktree 作成・runner 起動・結果収集をオーケストレーションする。

### runner 選択

```text
Arena

Player 1?
❯ Claude
  Codex

Player 2?
  Claude
❯ Codex
```

同じ runner 同士の対戦も将来的には許可するが、MVP では Claude vs Codex を主対象とする。

### タスク入力

```text
Task?
> Better Auth を導入して既存認証処理を置き換えてください
```

### タスクの洗練（refine）

ユーザーが入力したプロンプトはそのまま runner に渡さない。
runner はヘッドレスで質問できないため、曖昧な点はすべて runner の推測になり、
2 つの candidate が別の前提で作られて比較にならない。

そこで host（Claude Code）が起動前に次を行う。

1. 要求を理解し、関係するコードを読む（読み取りのみ）
2. runner が推測することになる点を洗い出す（範囲、対象ファイル、エッジケース、命名、互換性、テスト）
3. コードや慣習から決められるものは host が決める
4. 残りだけをユーザーに聞く（選択肢と推奨値付き、まとめて、最大 2 ラウンド）
5. 仕様（Goal / Background / Scope / Requirements / Acceptance criteria / Constraints / Verification / Decisions）を書く
   - 「何が満たされるべきか」は具体的に、「どう実装するか」は runner に委ねる（比較の余地を残す）
   - runner は HEAD から始まるため、未コミットの変更を前提にしない
   - 空のセクションは省き、詳細度はタスクの規模に合わせる
6. ユーザーが承認してから起動する（承認前に worktree 作成・setup・runner 起動をしない。
   修正・元の依頼のまま送る・キャンセルも選べる）

```text
Task?
> Better Auth を導入して既存認証処理を置き換えてください

(host がコードを読み、不明点を質問)
  - セッションストアは既存の Redis を使いますか？  ❯ はい / いいえ
  - 既存のログイン API のパスは維持しますか？      ❯ 維持 / 変更可

(host が仕様を提示)
Launch with this specification?
❯ Launch / Edit / Use the original request as is
```

runner が受け取るのは洗練後の仕様だけ。元の要求は session に `originalTask` として保存し、
`arena compare` でレビュアーに仕様と並べて見せる。

この工程を省く **simple mode** も用意する（`/arena simple <task>`、または `.arena.yaml` の
`refine: false` で既定化）。simple mode では入力をそのまま runner に渡す。

Core は LLM を呼ばない。`arena refine` は host 向けの brief（リポジトリ情報、手順、仕様テンプレート）を
出力し、元の要求を `~/.arena/drafts/` に保存するだけで、質問と仕様作成は host の責務。
`arena start --original-task-file <path>` で refined mode として記録する。

### 実行イメージ

```text
Claude Code
  ↓
/arena Skill
  ↓ (refine: 理解 → 質問 → 仕様化 → 承認)
Arena Core
  ├── Git worktree A
  │     └── Claude
  │
  └── Git worktree B
        └── Codex CLI
```

Skill 自体には orchestration logic を埋め込みすぎない。

```text
.claude/skills/arena/
  SKILL.md
        ↓
Arena Core
```

という依存方向にする。

Claude Code は最初のハーネスであり、Arena Core そのものではない。

### 将来の起動方法

Arena Core が安定した後、standalone CLI を追加可能にする。

```bash
arena "Better Auth を導入して"
arena --task task.md
arena --issue 123
```

さらに、Claude Code 以外のコーディングハーネスもメインのオーケストレーターとして対応する。

想定:

```text
Claude Code
   ↓
Arena Core

Codex
   ↓
Arena Core

agy
   ↓
Arena Core

Other coding harness
   ↓
Arena Core
```

つまり将来的には「Claude Code から Codex を runner として呼ぶ」だけでなく、

```text
Codex = host
Claude / Codex / Gemini = players
```

や、

```text
agy = host
Claude / Codex / Gemini = players
```

といった構成も可能にする。

このため、以下は分離する。

```text
Harness
  - Claude Code
  - Codex
  - agy
  - standalone CLI

Arena Core
  - session
  - worktree
  - runner lifecycle
  - result collection
  - comparison

Runner
  - Claude
  - Codex
  - Gemini
  - OpenCode
  - custom CLI
```

MVP では Claude Code harness のみ実装する。


---

## 5. 実行フロー

```text
arena
  ↓
repository validation
  ↓
runner selection
  ↓
task input
  ↓
task refinement (host; simple mode では省略)
  ↓
arena session 作成
  ↓
base commit 確定
  ↓
worktree A 作成
worktree B 作成
  ↓
Claude / Codex 並列実行
  ↓
各 runner 完了
  ↓
verification
  ├ test
  ├ lint
  └ typecheck
  ↓
git diff / stats 取得
  ↓
summary
  ↓
compare
  ↓
ユーザーが判断
```

---

## 6. Git Worktree 設計

各 runner は必ず別 worktree で実行する。

同一 working tree を複数 agent に共有させない。

### 例

```text
repo/
  main working tree

~/.arena/
  my-project/
    20260917-abc123/
      claude/
      codex/
```

branch:

```text
arena/20260917-abc123/claude
arena/20260917-abc123/codex
```

作成元は Arena 起動時点の HEAD。

### 重要

Arena 開始後に元 repository の branch が変更されても、Arena 内の比較対象は固定する。

session には必ず以下を保存する。

```text
repo path
base branch
base commit SHA
arena id
task            (runner に渡した内容。refined mode では仕様)
taskMode        (refined | simple)
originalTask    (refined mode のみ。ユーザーの入力そのまま)
runner list
worktree paths
branch names
startedAt
```

---

## 7. Runner abstraction

最重要の抽象化。

```ts
export interface ArenaRunner {
  id: string
  label: string

  isAvailable(): Promise<boolean>

  run(input: RunnerInput): Promise<RunnerResult>
}
```

```ts
export interface RunnerInput {
  task: string
  cwd: string
  branch: string
  arenaId: string
}
```

```ts
export interface RunnerResult {
  runnerId: string
  exitCode: number | null
  startedAt: string
  finishedAt: string
  stdoutPath: string
  stderrPath: string
}
```

runner 固有実装を core に漏らさない。

---

## 8. Claude Runner

Claude Code CLI を subprocess として実行する。

概念的には以下。

```bash
claude -p "<task>"
```

実際のオプションは実装時点の Claude Code CLI 仕様に合わせる。

Claude 側に渡す prompt には Arena 用共通ルールを prepend する。

例:

```text
You are participating in an implementation arena.

Work only inside the current repository/worktree.

Implement the requested task completely.

Before finishing:
- inspect existing implementation
- preserve existing behavior unless task requires otherwise
- run available tests
- run typecheck/lint when applicable

Do not interact with sibling arena worktrees.

TASK:
{userTask}
```

---

## 9. Codex Runner

Codex CLI も subprocess として実行する。

概念例:

```bash
codex exec "<task>"
```

Claude と同じ共通ルールを渡す。

モデル固有 prompt 差分を極力小さくし、比較条件を揃える。

---

## 10. Runner process management

各 runner は非同期 subprocess として起動する。

必要条件:

- 並列起動
- stdout 保存
- stderr 保存
- exit code 保存
- signal handling
- Ctrl+C 時に子 process を停止
- timeout は MVP では optional

例:

```text
Arena running

Claude   ● working  03:42
Codex    ● working  03:42
```

完了後:

```text
Claude   ✓ completed  06:31
Codex    ✓ completed  05:54
```

---

## 11. Session state

DB は使わず JSON で保存する。

```text
~/.arena/
  sessions/
    {arenaId}.json
```

例:

```json
{
  "id": "20260917-abc123",
  "repository": "/Users/me/project",
  "baseCommit": "abc123...",
  "task": "Better Auth を導入する",
  "status": "running",
  "players": [
    {
      "runner": "claude",
      "branch": "arena/20260917-abc123/claude",
      "worktree": "/Users/me/.arena/project/20260917-abc123/claude"
    },
    {
      "runner": "codex",
      "branch": "arena/20260917-abc123/codex",
      "worktree": "/Users/me/.arena/project/20260917-abc123/codex"
    }
  ]
}
```

将来的に以下を実現可能にする。

```bash
arena list
arena resume <id>
arena inspect <id>
arena clean <id>
```

---

## 12. Verification

runner の自己申告だけを信用しない。

Arena 側で runner 終了後に独立して verification を行う。

### コマンド判定

package.json 等から自動推定する。

候補:

```text
bun test
npm test
pnpm test

bun run lint
npm run lint

bun run typecheck
npm run typecheck
```

MVP では完全自動化にこだわらない。

設定ファイルで明示可能にする。

```yaml
verify:
  test: bun test
  lint: bun run lint
  typecheck: bun run typecheck
```

---

## 13. Result collection

各 worktree について最低限以下を取得する。

```text
exit code
duration
git status
git diff
changed files
added lines
deleted lines
test result
lint result
typecheck result
```

例:

```ts
export interface CandidateResult {
  runnerId: string

  durationMs: number

  git: {
    changedFiles: number
    additions: number
    deletions: number
    diffPath: string
  }

  verification: {
    test?: VerificationResult
    lint?: VerificationResult
    typecheck?: VerificationResult
  }
}
```

---

## 14. Compare

初期バージョンでは機械的なスコアリングは行わない。

まず事実情報を表示する。

```text
Arena complete

Claude
  duration      6m31s
  files         8
  diff          +312 / -94
  tests         PASS
  lint          PASS
  typecheck     PASS

Codex
  duration      5m54s
  files         6
  diff          +241 / -81
  tests         PASS
  lint          PASS
  typecheck     PASS
```

その後、

```text
What next?

❯ Compare implementations
  Inspect Claude diff
  Inspect Codex diff
  Keep both
  Clean arena
```

---

## 15. LLM による比較

`Compare implementations` を選択した場合のみ LLM review を行う。

比較対象として渡す情報:

```text
original task
base commit
Claude diff
Codex diff
verification results
```

レビュー観点:

```text
correctness
task completeness
regression risk
architecture fit
code complexity
existing conventions
test quality
unnecessary changes
```

比較 reviewer は runner とは独立した概念にする。

将来的には:

```text
Claude implements
Codex implements

Claude reviews Codex
Codex reviews Claude

final judge
```

という cross-judge に拡張可能。

### runner への質問（`arena ask`）

runner は一回きりのプロセスだが、会話（Claude の session / Codex の thread）はプロセス終了後も残る。
比較中に成果物の意図や欠落が読み取れないとき、ホストは `arena ask <id> <player> "<質問>"` で
その runner 自身の会話を worktree 内で再開し、実装時の文脈を持った本人に答えさせる。

```text
Claude : 起動時に --session-id <uuid> を固定 → claude -p --resume <uuid>
Codex  : 実行後に $CODEX_HOME/sessions の session_meta (cwd, 開始時刻) から thread id を特定
         → codex exec resume <thread-id>
custom : 設定の askArgs ({{sessionId}} {{prompt}} {{promptFile}} {{cwd}})
```

質問は読み取り専用。プロンプトで明示し、Claude は閲覧系ツールのみ (`--permission-mode dontAsk`
+ allow/deny list)、Codex は `sandbox_mode="read-only"` で再開する。さらに worktree の
フィンガープリント（HEAD + 作業ツリー全体の tree hash）を前後で比較し、変化していれば回答に
警告を付ける（collect 済みの結果が古くなるため）。回答は `results/<player>.ask-<n>.md` に保存し、
セッションの `players[].asks[]` に記録し、`arena compare` のバンドルに含める。

「直させる」（差し戻し）は意図的に含めない。修正はホストが synthesis で行う。

### 最終成果物の runner レビュー（`arena review`）

ホストが最終版（synthesis の結果、または as-is で採用した候補）を作ったあと、マージの前に
**すべての runner** にそれをレビューさせる。`arena review <id>` は `arena ask` と同じ仕組みで
各 runner の会話を読み取り専用で再開し、並列に走らせる。

```text
入力 : 選択済み候補 (session.selected) の worktree = 最終版
       base commit → 最終版 (未コミット分を含む) の diff を results/final.review-<n>.diff に保存
       各 runner に「最終版の場所」「自分の候補との関係」(自分の候補ベース / 相手の候補ベース /
       as-is 採用) を明示。相手の候補ベースの runner には「自分の worktree は最終版ではない」と伝える
出力 : 先頭行 VERDICT: approve | request-changes、続けて重要度順の所見
       ([blocker|major|minor|nit] <file>:<line> — 内容と直し方)
記録 : session.reviews[] にラウンド単位 (対象 player, 対象 HEAD, フィンガープリント, 各 runner の
       verdict / 回答パス / timeout / worktree 変化)。arena summary に verdict を表示
```

再開できない runner（worktree 削除済み、`askArgs` のない custom runner、旧バージョンのセッション）
やタイムアウトはラウンド全体を失敗させず、その runner のエントリに `error` / `timedOut` として残す。

verdict はホストへの入力であって指示ではない。ホストは blocker / major を自分でコードに当たって
検証し、認めた所見だけを選択済み worktree で直し、`arena collect --player` と `arena commit` の
あとで必要なら 2 ラウンド目を回す（skill は最大 2 ラウンド）。却下した所見は理由付きでユーザーに
見せる。runner に修正させることはしない。

---

## 16. 採用

MVP では採用を完全自動化しない。

```text
Select candidate:

❯ Claude
  Codex
  None
```

採用後も自動 merge はしない。

まずはユーザーへ branch 名を提示する。

```text
Selected: Codex

Branch:
arena/20260917-abc123/codex
```

将来的に:

```bash
arena adopt
```

で cherry-pick / merge / patch apply を行えるようにする。

---

## 17. ディレクトリ構成

MVP:

```text
arena/
├── .claude/
│   └── skills/
│       └── arena/
│           └── SKILL.md
│
├── src/
│   ├── arena.ts
│   ├── session.ts
│   │
│   ├── git/
│   │   ├── repository.ts
│   │   ├── worktree.ts
│   │   └── diff.ts
│   │
│   ├── runners/
│   │   ├── types.ts
│   │   ├── claude.ts
│   │   └── codex.ts
│   │
│   ├── process/
│   │   └── spawn.ts
│   │
│   ├── verification/
│   │   ├── detect.ts
│   │   └── run.ts
│   │
│   └── compare/
│       └── summary.ts
│
├── package.json
├── tsconfig.json
└── README.md
```

責務を細かくしすぎない。

MVP では framework 化より、Arena の end-to-end 動作を優先する。

---

## 18. 技術スタック

TypeScript + Bun を基本とする。

MVP では Claude Code が対話 UI を担当するため、standalone CLI 用の parser / prompt framework は必須としない。

候補:

```text
Runtime
  Bun

Harness
  Claude Code Skill

Process execution
  Bun.spawn

Schema
  zod

Git
  CLI を直接利用
```

Git 操作はライブラリ化せず、基本的には `git` CLI を直接呼ぶ。

理由:

- worktree support が確実
- Git 本体との差異を減らせる
- debugging しやすい

---

## 19. 設定

ユーザー設定:

```text
~/.config/arena/config.yaml
```

repository local:

```text
.arena.yaml
```

例:

```yaml
runners:
  claude:
    command: claude

  codex:
    command: codex

verify:
  test: bun test
  lint: bun run lint
  typecheck: bun run typecheck
```

優先順位:

```text
CLI option
>
repository config
>
user config
>
auto detection
```

---

## 20. Custom Runner

MVP 後、任意 CLI を追加可能にする。

例:

```yaml
runners:
  gemini:
    command: gemini
    args:
      - --prompt
      - "{{prompt}}"

  opencode:
    command: opencode
```

これにより Arena core の変更なしでモデル追加可能にする。

---

## 21. Harness integration

Arena Core と harness を分離する。

MVP:

```text
Claude Code
  ↓
Arena Core
```

将来:

```text
Claude Code ─┐
Codex ───────┼─→ Arena Core
agy ─────────┤
CLI ─────────┘
```

各 harness adapter は以下のみ担当する。

```text
起動 UX
対話
ユーザーへの進捗表示
Arena Core への入力
結果表示
```

worktree・runner lifecycle・verification・result collection などは Arena Core に置く。

これにより Codex や agy をメインハーネスとして追加しても、Arena 本体のロジックを複製しない。

---

## 22. Superset integration

Arena core 完成後に追加する。

Superset を Arena の必須 dependency にはしない。

integration の役割は主に UI。

例:

```text
arena
  ↓
worktree 作成
  ↓
Superset workspace として開く
```

候補:

```bash
arena --open superset
```

Superset の API / CLI が存在する場合のみ adapter を追加する。

---

## 23. Orca integration

Orca も optional backend / adapter として扱う。

Arena の以下の責務を Orca へ委譲可能性がある。

```text
runner execution
worktree lifecycle
run state
review
```

ただし Arena core が Orca に依存しないこと。

---

## 24. Claude Mods

MVP では利用しない。

Mods が将来安定した場合、以下に利用可能。

```text
Arena 状態 UI
Claude Code 内 command integration
task routing
runner lifecycle hook
結果表示
```

Arena runtime 自体は Mods から独立させる。

```text
Claude Mods
     ↓
Arena Core
     ↓
Claude / Codex / ...
```

この依存方向を逆にしない。

---

## 25. 安全性

runner はユーザー環境で CLI を実行するため、最低限以下を守る。

- worktree 外への書き込みを要求しない
- sibling worktree を参照させない
- Arena が勝手に main branch へ merge しない
- Arena が勝手に push しない
- Arena が勝手に remote branch を作らない
- Ctrl+C で全 runner を停止可能
- dangerous option は runner adapter 側で明示する

---

## 26. MVP の完成条件

以下が通れば v0.1 完成。

### Case

Git repository を Claude Code で開き:

```text
/arena
```

を実行。

Claude と Codex を選択。

同じタスクを入力。

Arena が:

1. 2つの worktree を作成
2. Claude / Codex を並列起動
3. それぞれがコードを変更
4. subprocess 完了を検出
5. test を実行
6. diff stats を取得
7. 比較結果を表示

できること。

さらに:

```bash
git worktree list
```

で両 candidate が完全に分離されていること。

---

## 27. 実装順序

### Phase 1

CLI skeleton。

```bash
arena
```

で task と player を取得。

### Phase 2

Git worktree manager。

Claude / Codex 用の branch + worktree を生成。

### Phase 3

Runner。

```text
ClaudeRunner
CodexRunner
```

を実装。

### Phase 4

並列 process execution。

stdout / stderr / exit status を保存。

### Phase 5

Result collector。

```text
git diff
git diff --stat
git status
```

を取得。

### Phase 6

Verification。

test / lint / typecheck。

### Phase 7

Compare UX。

結果を一覧表示。

### Phase 8

Session persistence。

resume / inspect / clean に備える。

---

## 28. 最初に実装しないもの

以下は魅力的だが、Arena の本質検証後に追加する。

```text
automatic winner selection
cross judge
multi-round tournament
3+ agents
cloud execution
web dashboard
Superset control
Orca backend
Claude Mods
MCP
GitHub PR creation
automatic merge
cost tracking
token accounting
```

---

## 29. 設計原則

### Arena Core は小さく保つ

Arena が行うのは、

```text
isolate
run
collect
compare
```

だけ。

### Runner は交換可能

Claude / Codex は Arena の特別扱いではなく runner plugin。

### Git を source of truth にする

candidate の成果物は独自フォーマットへ変換せず、Git branch / worktree として保持する。

### 自動化より可視性を優先

初期段階では「どちらが勝者か」を Arena が決めるより、人間が比較しやすい情報を出す。

### UI と Runtime を分離

将来:

```text
CLI
Claude Code
Superset
Orca
Web UI
```

のどこから呼ばれても同じ Arena Core を利用できるようにする。

---

## 30. 将来像

最終的には以下を目指せる。

```text
arena "Implement feature X"

        ┌─ Claude ────────┐
        │                 │
Task ───┼─ Codex ─────────┼─ Verification
        │                 │
        └─ Gemini ────────┘
                              ↓
                        Cross Review
                              ↓
                         Final Judge
                              ↓
                         Human Approval
```

さらに通常の Claude Code workflow から、

```text
simple task
→ Claude

large task
→ arena

architecture task
→ Claude + Codex review

uncertain implementation
→ Claude vs Codex
```

のように自動 routing する余地がある。

ただし、これは Arena core 完成後に行う。

---

# 最優先事項

最初の目標はこれだけ。

> Claude Code で `/arena` を実行すると、Claude と Codex が別 Git worktree で同じタスクを実装し、終了後に両方の結果を比較できる。

その後、Arena Core を維持したまま Codex、agy、standalone CLI などをメインハーネスとして追加する。

まずこれを確実に完成させる。
