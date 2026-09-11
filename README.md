# Tabi Plan

旅行の計画・共有ダッシュボードアプリです。行程・地図・チェックリスト・費用精算を仲間と共有できます。
フロントは GitHub Pages で配信する静的サイト、共有データの正本は VPS 上の MySQL API です。
静的ファイルに含めた情報は公開情報として扱い、非公開データは API 側の認可で制御します。

## 前提環境

| 項目 | 要件 |
| --- | --- |
| Node.js | 20 以上。CI は 22 で検証している |
| npm | 10 以上(npm workspaces を使う) |
| MySQL | 8 系。ローカル開発では VPS の MySQL に SSH トンネルで接続するか、手元に用意する |
| GitHub CLI | `npm run deploy:production` を使う場合だけ必要 |

## セットアップ

```bash
git clone https://github.com/nagomen/tabi-plan.git
cd tabi-plan
npm install              # frontend / api / contracts の依存をまとめて導入(lockfile はルートの 1 枚)
cp .env.sample .env      # 値を埋める。必須は DB_USER / DB_PASSWORD / SESSION_SECRET
```

`.env` は絶対にコミットしないでください(`.gitignore` 済み)。

## 実行

| コマンド | 用途 |
| --- | --- |
| `npm run dev` | フロントだけをローカル起動する(Vite) |
| `npm run dev:full` | SSH トンネル、DB マイグレーション、API、Vite を順に起動し、`http://localhost:5173/plans.html` を開く |
| `npm run build` | フロントを型検査してビルドする(出力 `frontend/dist`) |
| `npm run build:api` | API を `api/dist` へコンパイルする |

`npm run dev:full` の細かい挙動(ポート競合、トンネル省略、セッション秘密鍵の自動生成)は
[docs/local-development.md](docs/local-development.md) を参照してください。

## テスト

```bash
npm run ci               # 型検査 + Lint + テスト + 本番フロントビルド。PR を出す前に必ず通す
npm test                 # frontend / API のテストだけ
npm run test:coverage    # API のカバレッジ閾値を含む
npm run lint             # ESLint。await 忘れ、async 誤用、層の越境だけを検査する
```

個別に動かす場合は `npm run <script> -w frontend` / `-w api` です。

## ディレクトリ構成

```text
frontend/                 公開サイト(Vite + TypeScript、マルチページ)
  *.html                  各ページの入口(plans / plan-editor / index / mypage / person / login)
  public/                 ビルドを通さない静的ファイル(trip-config.js, sw.js, icon-*, webmanifest)
  src/shared/             全画面共有の TS
  src/<page>/             各ページの main.ts と、そのページ専用モジュール
  test/                   フロントのテスト
api/                      認証・認可・共有データ API(Node.js + MySQL)
  src/server.ts           HTTP、CORS、レート制限、セッション解決
  src/routes.ts           認可付きルーティング
  src/*-repo.ts           テーブルごとのデータアクセス
  schema/                 初期スキーマ
  scripts/migrate.mjs     本番差分マイグレーション
  test/                   API のテスト
contracts/                frontend と API が共有する通信 DTO
infra/                    VPS 側の nginx / systemd / バックアップ
tools/                    デプロイや開発補助のスクリプト
docs/                     詳細ドキュメント(下記)
```

## 設定と環境変数

API の設定はすべて環境変数から読み、起動時に `api/src/config.ts` で検証します。
必須の値が欠けている、または範囲外の場合は起動時に失敗します。
一覧と説明は [.env.sample](.env.sample) を正とします。

フロントの公開設定(API 接続先、通貨一覧など)は `frontend/public/trip-config.js` に置きます。
GitHub Pages に含まれるため公開情報として扱い、秘密情報は入れません。
詳細は [docs/trip-config.md](docs/trip-config.md) を参照してください。

## ブランチ運用と PR

- `main` だけで運用します(`dev` ブランチは設けていません)。`main` は常にデプロイ可能な状態を保ちます。
- `main` への直接 push は禁止です。作業ブランチを `type/短い説明`(例: `fix/csv-encoding`)で切り、PR を出してマージします。
- `main` はブランチ保護で PR と CI(`verify`)の成功を必須にしています。
- コミットメッセージは `type: 要約` の形式で、1 行目は 50 文字以内にします。`type` は `feat` / `fix` / `docs` / `refactor` / `test` / `chore` のいずれかです。次のコマンドでテンプレートを有効にできます。

```bash
git config commit.template .gitmessage
```

- PR の本文は `.github/PULL_REQUEST_TEMPLATE.md` に従い、`## 目的` から始めます。

## デプロイ

フロントは `main` へのマージで GitHub Pages に自動デプロイされます。
API は `Deploy API` ワークフローを手動実行します。両方をまとめて行う場合は次を使います。

```bash
npm run deploy:production
```

手順とワークフローの説明は [docs/deploy.md](docs/deploy.md)、VPS 側の運用は [infra/README.md](infra/README.md) を参照してください。

## トラブルシュート

| 症状 | 原因と対処 |
| --- | --- |
| API が `環境変数 X が設定されていません` で起動しない | `.env` に必須値が欠けている。`.env.sample` と見比べる |
| `SESSION_SECRET は32文字以上` で起動しない | 本番は 32 文字以上のランダム値を設定する。ローカルは `dev:full` が自動生成する |
| `dev:full` で DB に接続できない | SSH トンネルの設定(`LOCAL_DB_SSH_TARGET`)を確認する。直接接続できる環境では `LOCAL_DB_TUNNEL=0` |
| 5173 番ポートが使えない | 空いている次のポートを自動で選ぶ。実際の URL はターミナルに表示される |
| 画面の AI ボタンがエラーになる | API 側に `OPENAI_KEY` が未設定。未設定なら AI 機能は無効 |
| AI 生成で「AI サーバーへ接続できませんでした」 | 前段プロキシの読み取りタイムアウトが `OPENAI_TIMEOUT_MS` より短い。[docs/ai-consultation.md](docs/ai-consultation.md) を参照 |
| 保存時に 409 が返る | 別端末で先に更新されている。読み込み直してから編集する |

## 詳細ドキュメント

| ファイル | 内容 |
| --- | --- |
| [docs/local-development.md](docs/local-development.md) | `dev:full` の動作、ローカルデータの扱い |
| [docs/architecture.md](docs/architecture.md) | 画面構成、計画の作成と選択、共同計画、権限モデル、費用、地図 |
| [docs/ai-consultation.md](docs/ai-consultation.md) | AI 旅行相談、外部 AI 導線、移動候補検索、タイムアウト設計 |
| [docs/error-contract.md](docs/error-contract.md) | API エラーの共通形式とフロントでの扱い |
| [docs/trip-config.md](docs/trip-config.md) | `trip-config.js` と `TRIP_CONFIG_JSON`、場所検索の設定、公開範囲 |
| [docs/deploy.md](docs/deploy.md) | GitHub Actions によるデプロイ手順 |
| [infra/README.md](infra/README.md) | VPS 側の運用とバックアップ |
| [data/README.md](data/README.md) | ローカル開発用データ置き場 |

## 担当

- リポジトリ管理: [nagomen](https://github.com/nagomen)
- 不具合や要望は GitHub Issues に起票してください(テンプレートあり)。
