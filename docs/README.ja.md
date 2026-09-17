# bon-arena

[English](../README.md) | **日本語** | [简体中文](README.zh-CN.md)

2つのコーディングエージェントに**同じタスク**を**別々の git worktree** で実装させ、成果物（diff の統計、テスト、lint、typecheck）を比較して、採用するものを選べるツールです。

```
Claude Code (/arena)
      ↓
  依頼をあなたと一緒にワンショットで実装できる仕様へ洗練する   ("simple" で省略可)
      ↓
  Arena Core  ──┬── worktree A ── Claude Code CLI
                └── worktree B ── Codex CLI
      ↓
  収集 (diff, test, lint, typecheck) → 比較 → あなたが判断
```

Arena Core はハーネスに依存しない小さな CLI です。Claude Code の `/arena` skill が最初のホストで、他のホスト（Codex、単体利用、他のハーネス）からも同じ CLI を操作できます。

## 動作要件

- Node.js >= 22.18（または Bun。Node 互換 API のみ使用）
- git
- 対戦させる runner が PATH にあること: `claude`（Claude Code CLI）、`codex`（Codex CLI）、`agy`（Antigravity CLI）。この 3 つが組み込みで、それ以外の CLI も設定で追加できます

## インストール

npm に [`bon-arena`](https://www.npmjs.com/package/bon-arena) として公開しています（Node.js >= 22.18）。

```bash
npm install -g bon-arena
arena install-skill
arena doctor         # 作業したいプロジェクトで実行
```

更新は `npm install -g bon-arena@latest` を実行し、続けて `arena install-skill --force` を実行します。アンインストールは `npm uninstall -g bon-arena` を実行し、不要なら Claude Code の設定ディレクトリから `skills/arena` を削除します。arena のセッションと候補の worktree はパッケージのアンインストールでは削除されません。インストール後に `arena` が見つからない場合は、npm のグローバル bin ディレクトリを PATH に追加してください（macOS/Linux は `$(npm prefix -g)/bin`、Windows は `npm prefix -g`）。候補の実装は git worktree を使うので、arena の実行には git が必要です。

### インストールなしで使う（npx）

```bash
npx bon-arena doctor
npx bon-arena run --players claude,codex --task "API にレート制限を追加"
```

Claude Code の skill は PATH 上の `arena` を呼び、無ければ `npx bon-arena` にフォールバックしますが、グローバルインストールの方が速く、`/arena` を確認なしで使えます。

### GitHub や checkout から使う

コンパイル済みの CLI（`dist/`）をコミットしているので、リポジトリからもビルド無しでインストールできます。`npm install -g --install-links github:jacksuzuki/bon-arena`（このフラグは必須です。付けないと npm 10 は git パッケージを一時 clone への symlink として配置し、その clone を直後に削除します）または `npx --package github:jacksuzuki/bon-arena arena doctor` です。`#v0.4.0` でバージョンを固定できます。開発用:

```bash
git clone https://github.com/jacksuzuki/bon-arena.git
cd bon-arena
npm ci
npm run build        # dist/ はコミット対象。src/ を変えたら再ビルド
npm link             # この checkout を arena コマンドとして公開
arena install-skill
```

`arena install-skill` は同梱の skill を `~/.claude/skills/arena/SKILL.md` にコピーします。symlink もリポジトリのパスも不要です。インストール後は Claude Code を再起動してください。`CLAUDE_CONFIG_DIR` を尊重し、`arena install-skill --config-dir /path/to/claude-config` でも指定できます。繰り返し実行しても安全で、同一内容なら何もせず、内容が異なる場合は `--force` を付けない限り既存のものを保持します。アップグレード後の skill 更新や、以前の checkout ベースの symlink を置き換えるときは `--force` を使います。

## ホストモデルの推奨

`/arena` のホストは判断の重い仕事を担います。依頼を仕様に洗練し、runner の主張を検証し、最終版を仕上げる工程です。ホストは Mythos クラスのモデル（Fable 5.1）を effort **high** 以上で動かしてください。**最低ラインは Opus 5 の medium** です。runner のモデルは独立に選べるので、安価なものでも構いません。

`arena doctor` は Claude Code 内で動作中のホスト（セッションの transcript と `CLAUDE_EFFORT`）を検知し、基準未満なら `⚠` の警告を表示します。skill は開始前にその警告を伝えます。

```
host
  harness    Claude Code (session c8e40442)
  model      claude-fable-5-1  [session transcript]
  effort     high  [CLAUDE_EFFORT]
```

Claude Code の外ではホストは「未検知」と報告され、警告は出ません。

## Claude Code から使う

任意の git リポジトリで:

```
/arena 自前のセッション処理を Better Auth に置き換えて
```

Claude Code は Player 1 / Player 2 を尋ねたあと、何かを起動する前に**タスクを洗練**します。依頼が触れるコードを読み、runner が推測せざるを得ない点（範囲、対象ファイル、エッジケース、命名、互換性、テスト）を洗い出し、自分で決められない点だけをあなたに質問し、仕様（目的、範囲、要件、受け入れ条件、制約、検証、決定事項）を書きます。あなたが承認または編集してから、両プレイヤーがその仕様を持って隔離された worktree で起動されます。runner はヘッドレスで質問できないため、この工程が「2者が別々の推測をする」ことを防ぎます。元の依頼はセッションに保存され、`arena compare` で仕様と並べて表示されます。

洗練を省くには、コマンドラインで先に **simple モード**を選びます。文面はそのまま runner に渡されます。

```
/arena task --simple `Session` 型を `ArenaSession` にリネームして
/arena task-simple `Session` 型を `ArenaSession` にリネームして      # 同じ意味
```

`/arena task <text>`（または平文）は既定で洗練します。引数なしの `/arena` はプレイヤーと一緒にモードを尋ねます。`.arena.yaml` の `refine: false` でリポジトリの既定を simple モードにでき、`task --refine` は洗練を強制し、`/arena -- <text>` はキーワードで始まる文面をそのまま送ります。洗練中は何も起動されず、worktree が作られる前に仕様の編集やキャンセルができます。確認の段階でモードを再度選ぶことはありません。

runner の完了後、Claude Code は待機し、検証を実行してサマリーを表示し、**必ず先に比較を提示**します。事実、観点ごとの判断、推奨ベース、もう一方の候補の優れた点です。そのうえで次の行動を尋ねます。推奨は **Synthesize**（強い候補をベースにし、その worktree の中でもう一方の長所を取り込み、再検証して候補ブランチにコミット）です。どちらかの候補をそのまま採用することもできます。マージを尋ねる前に、Claude Code は**両方の runner に最終版をレビューさせます**（`arena review`）。各 runner は自分の会話を読み取り専用で再開し、最終版の diff を見て、verdict と所見を返します。Claude Code は所見を検証し、認めたものを直し、却下したものは理由と一緒に提示します。あなたのブランチへのマージ（`arena adopt`）はあなたが指示したときだけ行われ、push は決して行いません。

## ターミナルから使う

```bash
arena run --players claude,codex --task "API にレート制限を追加"   # simple モード: 文面をそのまま runner へ
arena run --players claude,agy --task "API にレート制限を追加"     # 組み込みはどれでも: claude, codex, agy（Antigravity）
# あるいは段階的に
arena start --players claude,codex --task-file task.md
arena wait latest
arena collect latest
arena compare latest        # LLM や人間のレビュアー向け Markdown バンドル
arena ask latest codex "リトライ上限が 2 なのはなぜ？"   # runner 自身の会話を読み取り専用で再開して質問
arena select latest codex
arena commit latest codex   # worktree の変更を候補ブランチにスナップショット
arena adopt latest          # 選択したブランチを現在のブランチにマージ (--ff / --squash)
arena clean latest          # worktree を削除。選択したブランチは残す

# ホストが行う仕上げ工程 (/arena では Claude Code が代行)
arena synthesize latest codex          # ベースをスナップショット + 選択し、もう一方の diff を表示
#   ...codex の worktree 内で編集...
arena collect latest --player codex    # 再検証
arena commit latest codex -m "arena: synthesis"
arena finish latest
arena review latest                    # 全 runner が最終版をレビュー (読み取り専用、並列)
arena review latest --instructions "リトライ経路を重点的に"   # 任意の指示。--players codex でレビュアーを限定
```

ターミナルからの洗練（CLI はモデルを呼びません。考えるのはホストか人間です）:

```bash
arena refine --task "API にレート制限を追加"   # ブリーフ: リポジトリ情報、手順、仕様テンプレート
                                             # 依頼を ~/.arena/drafts/<id>.original.md に保存
#   ...仕様を spec.md に書く (コードから決められない点はユーザーに聞く)...
arena start --players claude,codex --task-file spec.md \
            --original-task-file ~/.arena/drafts/<id>.original.md   # refined モード: 元の依頼を記録
```

モードを分けるのは `--original-task` / `--original-task-file` です。指定するとセッションは refined モード（`task` は仕様、`originalTask` は依頼、runner プロンプトには「合意済みの仕様であり、これに従うこと」が付く）になり、指定しなければ simple モードです。`arena doctor --json` はリポジトリの既定（`taskMode`）を報告します。

ディスク上の配置:

```
~/.arena/
  sessions/<id>.json                 セッション状態 (task, taskMode, originalTask, players, results …)
  drafts/<id>.original.md            `arena refine` が保存した依頼
  <project>/<id>/
    task.md                          runner に渡した内容
    task.original.md                 洗練前の依頼 (refined モードのみ)
    claude/  codex/                  worktree (ブランチ arena/<id>/<player>)
    logs/<player>.stdout.log …       runner の出力、exit code
    results/<player>.diff …          diff、status、検証ログ、arena ask の回答、
                                      arena review のレビュー (<player>.review-<n>.md, final.review-<n>.diff)
```

## 設定

`~/.config/arena/config.yaml`（ユーザー）と `.arena.yaml`（リポジトリ。こちらが優先）。CLI フラグは両方より優先され、`package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml` からの自動検出がフォールバックです。

```yaml
runners:
  claude:
    command: claude
    model: opus            # 任意
    extraArgs: []          # 組み込みの起動コマンドに追加
  codex:
    command: codex
  agy:                     # Antigravity CLI
    command: agy
    extraArgs: ["--effort", "high"]   # model / label / env も他の組み込みと同じ
  gemini:                  # 任意の CLI を runner にできる
    command: gemini
    label: Gemini
    args: ["--prompt", "{{prompt}}"]   # {{prompt}} {{promptFile}} {{task}} {{cwd}} {{branch}} {{arenaId}}
    askArgs: ["--resume", "{{sessionId}}", "--prompt", "{{prompt}}"]   # 任意: arena ask を有効にする
    env: { SOME_FLAG: "1" }

verify:
  test: bun test
  lint: bun run lint
  typecheck: false         # false でそのチェックを無効化
  timeout: 600             # コマンドごとの秒数 (setup にも適用)

setup: npm ci              # runner 起動前に各 worktree で実行
# setup: [npm ci, npm run codegen]
# setup: false             # 省略。既定は lockfile からの検出 (npm ci / pnpm / yarn / bun install)

refine: true               # ホストの既定タスクモード: true = 先に洗練, false = simple モード
```

新しい worktree には追跡ファイルしかないため、`setup` がないと runner と検証は `node_modules` を見つけられません。setup コマンドが失敗すると arena は中断され、その worktree は削除されます（`arena start --no-setup` や `--setup "<cmd>"` で一回限り設定を上書きできます）。

custom runner の `args` が `{{prompt}}` / `{{promptFile}}` を参照しない場合、プロンプトは stdin に渡されます。`askArgs` も同様で、custom runner にだけ必要です。未設定なら `arena ask` は「この runner は会話を再開できない」と報告します。

## ワークスペースアプリ連携 (Orca)

Arena は単体の CLI のままですが、[Orca](https://github.com/stablyai/orca) の中で動かすと候補を Orca 上に反映します。
Orca は登録済みリポジトリの worktree を自動検出するので、Arena が行うのはメタデータの付与だけです。
各候補はサイドバーに `arena <id> · <ラベル>` として並び、状態行
(`completed 4m12s · 5 files +120 −30 · test ✓ lint ✓ typecheck ✗ · selected`) が付き、ボード列が
実行中 → in-progress、完了 → in-review、採用 → completed と移動し、arena を開始した worktree の子として
まとまります。`arena clean` で worktree を消せば Orca 側からも消えます。

```bash
arena doctor            # "workspace apps" に連携が有効かどうかが出る
arena open latest codex # 候補の変更ファイルを Orca で diff として開く
```

設定は `integrations.orca: auto | true | false`（既定 `auto` = Orca 内で実行中のみ）。連携は表示専用かつ
best effort です。runner は従来どおり Arena が headless で起動するため `arena ask` / `arena review` や
runner の隔離はそのまま機能し、`orca` CLI が無い・失敗した場合も警告が出るだけです。Superset は自分で
作っていない worktree を表示する手段がないため、Superset 連携はまだありません。

## runner の起動方法

両プレイヤーは同じプロンプトを受け取ります。共通の arena ルール（現在の worktree 内だけで作業する、タスクを完遂する、テストを実行する、push しない）に続けてタスクをそのまま渡します。refined モードではタスクはユーザーと合意した仕様で、ルールに「この仕様は確定済み」が加わります。元の依頼はプロンプトに含まれないので、runner が再解釈することはありません。

| Runner | 起動コマンド |
|---|---|
| Claude | `claude -p --dangerously-skip-permissions --output-format text --settings '{"autoMemoryEnabled":false}'`（プロンプトは stdin） |
| Codex  | `codex exec -C <worktree> --sandbox workspace-write -c approval_policy="never" -o <results>/codex.last-message.md -` |
| Antigravity | `agy --add-dir <worktree> --dangerously-skip-permissions --print-timeout 12h --output-format stream-json -p=<prompt>` |

ヘッドレス実行では権限の確認に答えられないため、Claude は権限チェックをスキップして動きます。隔離は権限システムではなく専用の worktree によるものです。各 runner は detached な supervisor プロセスに監視され、exit code が記録されるので、`arena` コマンドは終了してあとから戻れます（`arena wait`、`arena status`）。`arena stop` はプロセスグループ全体を終了します。

`agy` はプロセスのカレントディレクトリでは作業せず、stdin からプロンプトを読むこともできません。そのため worktree を `--add-dir` で、プロンプトを `-p=<prompt>` の 1 引数で渡します。print モードは既定で 5 分で打ち切られるので `--print-timeout` を明示し、会話 ID が出力に含まれる `stream-json` で起動します（runner のログはプレーンテキストではなく NDJSON になります）。

runner の環境からは `CLAUDECODE` / `CLAUDE_CODE_*` を取り除くので、Claude Code 内から起動した Claude runner が「入れ子」と誤認することはありません。Claude Code の auto-memory はリポジトリ単位なので、worktree 内の runner はそのままではホストプロジェクトのメモリを読み書きしてしまいます。そのため Claude runner は `--settings '{"autoMemoryEnabled":false}'` を渡し、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` を設定します。

### 終了した runner に質問する（`arena ask`）

runner は一回きりのプロセスですが、会話はプロセスの終了後も残ります。`arena ask <id> <player> "<質問>"` は runner 自身の会話を worktree 内で再開するので、コードを書いた本人が、実装時の文脈を持ったまま答えます。回答は `results/<player>.ask-<n>.md` に保存され、セッションに記録され、`arena compare` にも含まれるため、レビュアーは diff の隣で runner 自身の説明を読めます。

| Runner | 再開コマンド |
|---|---|
| Claude | `claude -p --resume <session-id> --output-format text --permission-mode dontAsk --allowedTools <読み取り専用の一覧> --disallowedTools Edit,Write,MultiEdit,NotebookEdit --settings '{"autoMemoryEnabled":false}'` |
| Codex  | `codex exec resume -c sandbox_mode="read-only" -c approval_policy="never" <thread-id> -` |
| Antigravity | `agy --conversation <conversation-id> --add-dir <worktree> --sandbox --dangerously-skip-permissions --print-timeout 1h --output-format text -p=<prompt>` |

質問は厳密に読み取り専用です。プロンプトでそう指示し、Claude は閲覧系ツールに、Codex は read-only サンドボックスに制限し、さらに worktree のフィンガープリントを前後で比較します。それでも変更があった場合は回答に警告が付くので、以前の結果を信用する前に `arena collect --player <p>` をやり直してください。`arena ask` は候補を理解するためのもの（「この変更は仕様のどの項目？」「なぜこのテストは Windows でスキップ？」）で、修正を頼むためのものではありません。修正は synthesis ステップでホストが行います。

**Antigravity は例外です。** `agy` には読み取り専用モードが無い（print モードでは `--mode plan` でも `--sandbox` でもファイルを書けます）ため、`agy` の player に対する `arena ask` / `arena review` の読み取り専用はベストエフォートです。プロンプトで変更を禁じ `--sandbox` を付けますが、強制はできません。worktree が変わった場合は上記の警告が出ます。

Claude の会話 ID は起動時に固定します（`--session-id`）。Codex にはそのフラグがないため、実行後に `$CODEX_HOME/sessions` を worktree のパスと開始時刻で検索して thread id を特定します。Antigravity にもそのフラグはなく、会話 ID は実行時の stdout ログ（`stream-json`）から読み取ります。worktree を clean したセッションや、`arena ask` 実装前のバージョンで開始したセッションには質問できません。custom runner には設定の `askArgs` が必要です。

### 最終版を runner にレビューさせる（`arena review`）

候補を選択したら（synthesis の結果でも、as-is で採用した候補でも）、`arena review <id>` は `arena ask` と同じ読み取り専用の再開で、**すべての runner** に最終版を並列でレビューさせます。各レビュアーには、base commit から選択済み worktree まで（ホストの未コミット編集を含む）の diff、worktree のパス、そして最終版と自分の候補との関係（「あなたの候補をベースにホストが編集」「もう一方の候補がベース」「そのまま採用」）が伝えられます。選ばれなかった runner には、自分の worktree は最終版ではないと明示します。回答は固定形式です。1 行目が `VERDICT: approve` または `VERDICT: request-changes`、続いて `blocker` / `major` / `minor` / `nit` の順にファイルと行を添えた所見。`--instructions "<文>"` でレビュアーの注目点を追加でき、`--players` でレビュアーを限定できます。

ラウンドはセッションに記録され（`reviews[]`: 対象 commit、runner ごとの verdict、回答パス）、回答は `results/<player>.review-<n>.md`、レビュー対象の diff は `results/final.review-<n>.diff` に保存され、`arena summary` に verdict が出ます。再開できない runner やタイムアウトはラウンドを失敗させず、`not asked` / `timed out` として記録されます。verdict はホストへの入力であって命令ではありません。`/arena` では Claude Code が blocker / major の所見をコードに当たって検証し、認めたものだけを選択済み worktree で直して再検証し、何かを変えたときは 2 ラウンド目を回します（最大 2 ラウンド）。却下した所見は理由付きでユーザーに提示します。runner が自分で修正することはありません。

## プロジェクト構成

```
src/
  arena.ts            CLI (薄いコマンド層)
  core.ts             start / wait / stop / collect / select / commit / synthesize / adopt / clean
  refine.ts           タスク洗練のブリーフ + 仕様テンプレート (質問するのはホスト)
  host.ts             ホストのモデル/effort 検知と最低基準の警告 (arena doctor)
  session.ts          JSON セッション状態 (zod スキーマ)
  config.ts           config.yaml / .arena.yaml
  git/                repository, worktree, diff
  runners/            ArenaRunner インターフェース, claude, codex, agy, custom, prompt
  process/            detached supervisor + spawn ヘルパー
  verification/       test/lint/typecheck の検出と実行
  compare/            status, summary, Markdown 比較バンドル
.claude/skills/arena/SKILL.md   Claude Code ホスト
```

## 開発

```bash
npm ci
npm run build                # dist/ はコミット対象: src/ の変更と一緒に再ビルドしてコミット
npm link                     # 任意: この checkout を `arena` として公開
npm run typecheck
npm test
npm run test:package          # pack し、使い捨ての prefix にインストールして CLI + skill を検証
npm run dev -- doctor          # ビルドせずソースから実行
ARENA_HOME=/tmp/arena npm run dev -- run --players a,b --task "..."
```

## 配布

Node.js と npm が入ったメンテナの checkout で:

```bash
npm ci
npm run typecheck
npm test
npm run test:package
npm run build
npm pack                     # bon-arena-<version>.tgz を生成
```

リリース手順: バージョンを上げ（`npm version patch|minor`）、`npm run build` で `dist/` を再生成してコミットし、`npm publish --access public --otp=<code>`（アカウントは 2FA 必須）を実行してから `git push --follow-tags` します。`prepublishOnly` フックが先に typecheck、ユニットテスト、パッケージのスモークテストを実行します。このリポジトリは自動公開しません。生成した `.tgz` を直接配布して `npm install -g ./bon-arena-<version>.tgz` でインストールしてもらうこともできます。

## v0.1 に含まれないもの

勝者の自動決定、相互レビュー、3体以上のプレイヤー、トーナメント、クラウド実行、Web UI、Superset アダプタ、Orca への runner 実行委譲、MCP、PR 作成、自動マージ、コスト計測。

## ライセンス

[MIT](LICENSE) — Copyright (c) 2026 Shuichi Suzuki.
