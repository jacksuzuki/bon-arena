# Public release audit

## 対象と結論

2026-09-17 に `jacksuzuki/ccc-arena` の public 公開に向けて実施した監査。
変更元 HEAD は `038d4a83777a48357e962c91b1d04ed6986fb2f1`。
追跡ファイル 36 件と今回の公開準備変更を調査した。
履歴は現在のブランチだけでなく、実行時の `git rev-list --all` で到達できた
全 10 コミット、全 36 パス、重複を除く 82 blob を対象にした。
この履歴集合は `a1610ca45ec58dcb6f22e571325cdc2d3d85f1f9` とその祖先で再現できる。
shallow repository ではなく、削除済みの内容や merge 前の内容も各 commit の tree から調べた。
コミットの author / committer / 本文、ref 名と注釈も確認した。

**調査範囲で、実際の秘密情報や、公開を妨げる明示的なライセンス衝突は見つからなかった。**
作者の実名・メールアドレスは履歴に残る。公開可否とコードの権利については下記の人間向け確認が残る。
GitHub リポジトリ作成、push、npm publish、履歴書き換えは実施していない。
`ARENA_DESIGN.md` は変更していない。

対象はこの worktree と Git の到達可能な履歴であり、他の worktree、外部のホームディレクトリ、
到達不能 object / reflog、未取得の remote 履歴は調査していない。
パターン検索と該当箇所の確認による監査であり、未知の形式・難読化された秘密情報の不在や、
外部コードとの一致の不在を証明するものではない。脆弱性データベースの照会は対象外。

## 確認項目 / 結果 / 根拠 / 人間が判断すべき事項

| 確認項目 | 結果 | 根拠 | 人間が判断すべき事項 |
|---|---|---|---|
| API キー・トークン・秘密鍵・パスワード | 実値は未検出 | 全 82 blob、作業ツリー、commit metadata に対する下記の検索。鍵ヘッダー、AWS / GitHub / OpenAI / Slack / Google 系のパターン、JWT は該当なし。一般語の一致は `process.env`、テストの password reset、文書の token accounting 等 | 公開直前に最終 commit を再走査する。検索だけでは未知の形式は排除できない |
| `.env`・認証ファイル・バイナリ | 履歴内に該当するファイルなし | 全 commit の `git ls-tree -r` で機密ファイル名を検索。全 blob が UTF-8 として読め、submodule / 非 blob エントリなし。`node_modules`、生成物、鍵ファイルの追跡なし | 新しい設定や添付物を追加した場合は再確認 |
| 個人メール・実名 | author / committer は全 10 commit とも Shuichi Suzuki と同一の Gmail アドレス | `git log --all --format=fuller`。メール実値はここには再掲しない。commit 本文には `Claude Fable 5.1 <noreply@anthropic.com>` の共著者表記もある | 作者メールを公開してよいか判断する。非公開にする場合は人間が公開前に履歴変更を行う。今後の git 設定変更だけでは既存履歴は消えない |
| ファイル内のメール | 個人のメール実値は未検出（この報告書を除く） | `test/refine.test.ts` の `arena@test` はテスト用 git identity。CI の `checkout@v4` 等はメールではない | テスト値はそのままでよい |
| ローカル絶対パス・ホスト名 | 個人のパス・内部ホストは未検出 | `ARENA_DESIGN.md` の `/Users/me/...` はプレースホルダ。テストの `/home/.arena/...`、`/repo`、`/wt`、`/opt/codex` 等も固定 fixture。URL は npm registry、GitHub の公開先・sponsor URL。内部ドメイン・IP の実値なし | `ARENA_DESIGN.md` は合意どおりそのまま公開 |
| 本体のライセンス | MIT 宣言と本文を一致させた | `LICENSE` に `Copyright (c) 2026 Shuichi Suzuki` と MIT 本文。`package.json` も MIT | 第三者・勤務先等の権利が含まれないかは作者が最終確認 |
| ランタイム依存 | yaml 2.9.1: ISC、zod 4.6.5: MIT。ライセンス未指定なし | 唯一の履歴内 lockfile と現在の lockfile が同一。インストール済みの両パッケージの `LICENSE` 本文も確認。両者に lockfile 上の推移的ランタイム依存なし | 将来依存本体を同梱・改変する場合は、それぞれの著作権・許諾表示を維持する |
| 開発用・推移的依存 | `@types/node` 22.20.3 と `undici-types` 6.21.0 は MIT。TypeScript 7.0.2 と 20 種の optional platform package は Apache-2.0 宣言 | lockfile の全 25 依存エントリは MIT 3、ISC 1、Apache-2.0 21。インストール済みの LICENSE と TypeScript / darwin-arm64 の NOTICE を確認。未インストール platform は lockfile の宣言まで | TypeScript の NOTICE は MIT / BSD / Unicode / W3C / CC-BY / Go 関連表示等を含む。開発ツール自体を再配布する場合は別途その表示を確認する |
| 出所不明なコード・素材 | 第三者からのコピーを示すヘッダー・URL・帰属表示や vendored code は未検出。外部由来の有無は断定しない | 履歴内の全パスと provenance 検索、`git log --all -m -p`、ソース・テスト・skill の確認。MVP は `e353eaa` で追加され、その後の変更にも AI 共著者の記録がある。画像・フォント・外部 SDK の埋め込みなし | 作者がコード・文書・AI 生成物を含め MIT 公開できる権利を確認する。履歴や検索結果だけでは権利の証明にならない |
| 他製品への言及 | 変更なし | `ARENA_DESIGN.md` の Superset / Orca / agy / Claude Mods は設計上の言及。該当製品の依存・ソース同梱は未検出 | そのまま公開するという既定の判断を維持 |
| 実行時データ | 追跡されていないが、生成物に秘密情報が入り得る | `src/process/spawn.ts` は継承した環境変数を supervisor spec に保存し、`src/core.ts` は `logs/<player>.spec.json` に出力する。セッションには依頼文・パス、ログには runner 出力が残る | 実行済みセッションを公開しない。`ARENA_HOME` を任意の場所へ変えた場合、その場所も別途管理する |
| `.gitignore` | 不足を補完 | `.env*`（sanitized example は例外）、`.npmrc`、鍵、`.arena/`、ローカル Claude 設定、テストの一時フォルダ、`.tgz` を追加。`git check-ignore` で動作確認 | ignore は既に追跡されたファイルを消さず、`git add -f` も防がない |
| パッケージ公開範囲・bin | 妥当。LICENSE を明示的に追加 | `npm pack --dry-run --json` 成功、26 ファイル。`dist/` 22 ファイル、skill、README、LICENSE、package.json のみ。`arena` は shebang 付き `dist/arena.js` を指す。依存の bundled 配列は空 | 実際の配布直前に pack 内容を再確認。監査書・CI・ソース・テスト・node_modules は npm archive に含まれない |
| メタデータ・導入手順 | 公開先を統一 | repository / homepage / bugs を `jacksuzuki/ccc-arena` に設定し author は実名のみ。README は clone → npm ci → npm link を先頭にし、npm 公開後の手順は条件付きにした | リポジトリ作成と push は人間が実施 |
| CI | secret 不要の最小構成 | `push` / `pull_request`、Node 22、`npm ci` → typecheck → test。`contents: read`、checkout の credential 永続化なし。YAML を既存の yaml で parse し構成を検査 | GitHub 上での実行は未検証。fork PR は GitHub の初回実行承認ポリシーに従う |

## 再現方法

リポジトリの root で実行する。以下のコマンドはファイル内容やメールを出力するため、
検索結果そのものを無確認で公開しない。`rg` の終了コード 1 は一致なしを意味する。
この監査書自体には検索語や例があるため、追加後の再実行ではそれらも一致する。

### クイックチェック（grep）

網羅的な走査の前に、追跡ファイルと履歴の差分を手早く確認する。いずれも一致なし（終了コード 1）が期待値。
一致した場合は `token accounting`（設計書）、`Add password reset`（テストの固定文）のような自然言語かを確認する。

```bash
git ls-files
git log --all --format='%h %an <%ae> %cn <%ce> %s'
git log --all --name-only --pretty=format: | sort -u | grep -E -i '(^|/)\.env|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519|credentials|secrets?\.(json|ya?ml)|\.npmrc|\.netrc'
git grep -n -i -E 'sk-ant-|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|gho_|AKIA[0-9A-Z]{16}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key|secret|token|password|passwd|Authorization:' -- . ':!package-lock.json'
git log -p --all --format='commit %h' | grep -n -i -E '^[+-].*(sk-ant-|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|xox[baprs]-|-----BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|secret\s*[:=]|token\s*[:=]|password\s*[:=]|Authorization:)'
git grep -n -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' -- . ':!package-lock.json'
git log -p --all --format='commit %h' | grep -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' | sort -u
git grep -n -E '(/Users/|/home/|C:\\\\|/private/|/var/folders|\b[0-9]{1,3}(\.[0-9]{1,3}){3}\b|\.local\b|\.internal\b|ngrok|localhost:[0-9]+)' -- . ':!package-lock.json'
git rev-list --objects --all | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' | awk '$1=="blob" && $2>100000'
npm pack --dry-run
```

### 対象・コミット本文・差分

```bash
git rev-parse HEAD
git rev-parse --is-shallow-repository
git ls-files --stage
git rev-list --all
git log --all --format=fuller --no-patch
git for-each-ref --format='%(refname) %(objectname) %(contents)'
git log --all -m -p --format=fuller -- src .claude scripts test |
  rg -n -i 'copyright|SPDX|license|copied|adapted|derived|https?://|password|token|secret|api.?key|credential|hostname'
git diff -- ARENA_DESIGN.md
```

### 全履歴のファイル内容と現在の公開対象

削除された秘密情報を見逃さないよう、各 commit の tree から全 blob を取得し、
重複する内容は一度だけ検索する。binary / 非 UTF-8 があれば別途調査する。
初回監査の履歴だけを再現する場合は `git('rev-list', '--all')` を
`git('rev-list', 'a1610ca45ec58dcb6f22e571325cdc2d3d85f1f9')` に置き換える。

```bash
python3 - <<'PY'
import re
import subprocess
from collections import defaultdict
from pathlib import Path

def git(*args):
    return subprocess.check_output(['git', *args])

patterns = {
    'secret': r'(?i)(-----BEGIN[ A-Z]*(?:PRIVATE KEY|PGP PRIVATE)|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,})|\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)',
    'credential-context': r'(?i)(api[_-]?key|access[_-]?key|client[_-]?secret|token|password|passwd|credential|authorization|secret|private[_-]?key|\.env|_auth)',
    'email': r'[A-Za-z0-9_.+%-]+@[A-Za-z0-9.-]+',
    'personal-path-host': r'(?i)(/Users/[^\s"\x27`]+|/home/[^\s"\x27`]+|[A-Z]:[\\/][^\s"\x27`]+|\b(?:[A-Za-z0-9-]+\.)+(?:local|internal|lan|corp)\b|\b(?:\d{1,3}\.){3}\d{1,3}\b|hostname|https?://[^\s"\x27`]+|ssh://[^\s"\x27`]+)',
    'provenance': r'(?i)(copyright|SPDX|license|copied from|adapted from|derived from|stackoverflow|github\.com|https?://)',
}
sensitive = re.compile(r'(?i)(^|/)(\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials(?:\..*)?)$|\.(pem|key|p12|pfx|jks|keystore)$')
commits = git('rev-list', '--all').decode().splitlines()
blobs, paths = defaultdict(set), set()
for commit in commits:
    for entry in git('ls-tree', '-r', '-z', commit).split(b'\0'):
        if not entry:
            continue
        meta, raw_path = entry.split(b'\t', 1)
        mode, kind, oid = meta.decode().split()
        path = raw_path.decode()
        paths.add(path)
        if kind == 'blob':
            blobs[oid].add(path)
        else:
            print('NON-BLOB', commit, mode, kind, path)
print('COUNTS', len(commits), 'commits', len(paths), 'paths', len(blobs), 'blobs')
print('SENSITIVE HISTORICAL FILENAMES', sorted(p for p in paths if sensitive.search(p)))

def scan(label, data):
    try:
        content = data.decode('utf-8')
    except UnicodeDecodeError:
        print('NON-UTF8', label)
        content = data.decode('utf-8', errors='replace')
    for number, line in enumerate(content.splitlines(), 1):
        for category, pattern in patterns.items():
            if re.search(pattern, line):
                print(category, label, number, line)

for oid, names in sorted(blobs.items()):
    scan(oid + ':' + ','.join(sorted(names)), git('cat-file', 'blob', oid))
scan('commit-metadata', git('log', '--all', '--format=fuller', '--no-patch'))
scan('refs', git('for-each-ref', '--format=%(refname) %(contents)'))
for raw in git('ls-files', '-c', '-o', '--exclude-standard', '-z').split(b'\0'):
    if raw:
        path = Path(raw.decode())
        scan('worktree:' + str(path), path.read_bytes())
PY
```

履歴内の lockfile は blob `771e5f4b258166f2ccb0d25f18cb7be07d915ae3` の 1 種のみ。
次のコマンドで現物と依存のライセンス宣言を確認できる。

```bash
git show 771e5f4b258166f2ccb0d25f18cb7be07d915ae3
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs'
const { packages } = JSON.parse(readFileSync('package-lock.json', 'utf8'))
for (const [path, pkg] of Object.entries(packages)) {
  if (path) console.log(path, pkg.version, pkg.license, pkg.dev ? 'dev' : 'runtime')
}
JS
cat node_modules/yaml/LICENSE node_modules/zod/LICENSE
cat node_modules/@types/node/LICENSE node_modules/undici-types/LICENSE
cat node_modules/typescript/LICENSE node_modules/typescript/NOTICE.txt
# インストールされた platform の LICENSE / NOTICE も確認する。
cat node_modules/@typescript/typescript-darwin-arm64/LICENSE
cat node_modules/@typescript/typescript-darwin-arm64/NOTICE.txt
```

## 検証結果

ローカル環境: Node.js v22.21.1 / npm 10.9.4。既に `npm ci` 済みの依存を使用した。
一時データと npm cache は worktree 内に限定して実行した。

```bash
mkdir -p node_modules/.cache/public-release-audit/tmp
export TMPDIR="$PWD/node_modules/.cache/public-release-audit/tmp"
export XDG_CONFIG_HOME="$PWD/node_modules/.cache/public-release-audit/config"
export npm_config_cache="$PWD/node_modules/.cache/public-release-audit/npm"
npm run typecheck
npm test
npm pack --dry-run --json
npm_config_fetch_retries=0 npm_config_fetch_timeout=15000 npm run test:package
git diff --check
git check-ignore .env .env.local subdir/.env.production .npmrc test.pem test.key \
  test.p12 test.pfx id_rsa id_ed25519 .arena/session.json \
  .arena-package-test-demo/file .arena-install-test-demo/file \
  .claude/settings.local.json ccc-arena-0.1.0.tgz
git check-ignore --no-index .env.example .env.test.example .claude/skills/arena/SKILL.md .arena.yaml
```

| 検証 | 結果 |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | PASS: 32 tests、失敗・skip なし |
| `npm pack --dry-run --json` | PASS: prepare/build 成功、26 files、LICENSE / CLI / skill を確認 |
| `npm run test:package` | 未完走: pack と内容検査の後、依存取得時に `ENOTFOUND registry.npmjs.org`。グローバルインストール・CLI shim・skill の一連の smoke test はこの環境では未検証 |
| CI YAML / lockfile 整合性 / CLI shebang | PASS: yaml parser と Node assert で検査。依存・version・engines は lockfile と一致し、lockfile 変更不要 |
| `git diff --check` | PASS |
| `git check-ignore` | 機密・生成物の例は ignore。example env / skill / `.arena.yaml` は非 ignore（最後のコマンドは終了コード 1） |
| lint | lint script / 設定なし。追加の lint は実施していない |
| GitHub Actions 実行 | 未実施。リポジトリ作成・push 後に確認する |

## 人間向けの残タスク

1. **git author のメールアドレス**（全コミットの author / committer に同一の Gmail アドレス）の公開可否を決める。
   公開後は `git log` と GitHub のコミットページで誰でも閲覧できる。隠す場合は push 前に
   `git filter-repo --mailmap` などで履歴を書き換え、再監査する（本作業のスコープ外）。置換先は GitHub の
   noreply アドレス（`<id>+jacksuzuki@users.noreply.github.com`）が一般的。書き換えない場合は、GitHub
   アカウントにこのアドレスを登録しておくとコミットがアカウントに紐づく。
2. **`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` トレーラー**（複数コミット）と、arena が生成した
   コミット本文の日本語タスク文（`9c80a7a`, `0fc2e1e`）: 公開して問題はないが、整理するなら 1. と同時に行う。
3. **push するのは `main` だけにする。** ローカルには arena が作った ref（`arena/20260917-*/{claude,codex}`）が
   残っている。`git push -u origin main` を使い、`git push --all` や `--mirror` は使わない。不要な arena
   ブランチは `git branch -D arena/...` で消してよい。
4. ソース・文書・AI 生成物の権利を最終確認する。外部から持ち込んだコードがある場合は、その出所と表示条件を確認する。
5. この監査書を公開物に残すか決める。削除するなら公開対象の最初の commit に入れる前に判断する。
6. **GitHub 側の設定**: リポジトリ作成後に Description / Topics を設定し、`package.json` の `homepage`
   （`https://github.com/jacksuzuki/ccc-arena#readme`）が実在することを確認する。Actions を有効にすると
   `ci.yml` が最初の push で走るので成功を確認する。
7. **配布方法**: npm 10.9 では `prepare` スクリプトが存在するだけで `npm install -g <git>` の配置が空になる
   （最小パッケージで実測）。そのため `prepare` を廃止し、ビルド済み `dist/` をコミットしている。
   `npm install -g github:jacksuzuki/ccc-arena` と `npx --package github:jacksuzuki/ccc-arena arena …` は
   ビルド無しで動く。CI の `npm run check:dist` が `dist/` の陳腐化を検出する。npm に publish したら README の
   Install 節を更新する。
8. ネットワークが使える環境で `npm run test:package` を完走させる。
9. 最終変更をレビューし、公開対象の branch / tag とファイルを再走査してから push する。
