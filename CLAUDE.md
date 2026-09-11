# CLAUDE.md

## プロジェクト概要

旅行の計画・共有ダッシュボード。フロントは Vite + TypeScript の静的サイト(GitHub Pages)、API は Node.js + MySQL(VPS)。
npm workspaces 構成で、`frontend` / `api` / `contracts` の 3 パッケージがある。

## よく使うコマンド

```bash
npm install              # 依存導入(ルートで 1 回)
npm run dev:full         # フロント + API + DB トンネルを一括起動
npm run ci               # 型検査 + Lint + テスト + ビルド。PR 前に必ず通す
npm test                 # テストだけ
npm run lint             # ESLint(await 忘れ、async 誤用、層の越境)
```

## コーディングルール

- `main` への直接 push は禁止。`type/短い説明` の作業ブランチを切り、PR でマージする。`dev` ブランチはない。
- コミットメッセージは `type: 要約`(50 文字以内)。`type` は `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。本文には「なぜ」を書く。
- PR 本文は `.github/PULL_REQUEST_TEMPLATE.md` に従い、`## 目的` から始める。丁寧語で書く。
- 各ページの `frontend/src/<page>/main.ts` は入口として薄く保つ。ロジックは同じディレクトリの責務ごとのモジュールに置く。
- `frontend/src/shared/` は全画面共有。ページ固有のコードを置かない。
- API の HTTP 層(`server.ts` / `routes.ts`)は repo を経由し、DB ドライバへ直接触れない(ESLint で検査)。
- 環境変数は `api/src/config.ts` だけで読む。
- 秘密情報(鍵、トークン、パスワード)をコード、ログ、`trip-config.js` に書かない。静的ファイルは公開情報として扱う。

## 触ってはいけない場所

- `api/dist/`、`frontend/dist/`、`api/coverage/` は生成物。直接編集しない。
- `.env` はコミットしない。雛形は `.env.sample`。
- `data/store/*.json` は個人データを含むローカル専用。

## 参考ドキュメント

- [README.md](README.md)
- [docs/](docs/)
- [infra/README.md](infra/README.md)
