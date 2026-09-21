# 参加したときの初回セットアップ

このリポジトリで開発を始めるまでの手順です。1 回通せば、次からは `npm run dev:full` だけで起動できます。

## 0. 事前に必要なもの

| 項目 | 要件・入手先 |
| --- | --- |
| Node.js | 20 以上（CI は 22 で検証） |
| npm | 10 以上 |
| SSH 公開鍵 | 手元の鍵を VPS の `authorized_keys` に登録してもらう。登録済みかはリポジトリ管理者に確認する |
| VPS のホスト | 管理者に教えてもらう。このリポジトリは公開なので書きません（GitHub Secrets の `PRODUCTION_SSH_HOST` と同じ値です） |
| DB パスワード | VPS 上の環境ファイル `~/secure_env/travel-api.env` の `DB_PASSWORD` |

以下では VPS のホストを `<VPSホスト>` と書きます。自分の手元では実際の値に置き換えてください。

**`.env` を他の人から受け取らないでください。** 本番 DB のパスワード、OpenAI API キー、LINE のチャネルシークレットが入ったファイルなので、チャットやメールで配ると、その履歴に秘密情報が残り続けます。`.env` は各自が `.env.sample` から作ります。

## 1. SSH でつながることを確認する

MySQL は VPS の localhost にだけ待ち受けているため、手元から DB を触るには SSH トンネルが必要です。まずログインできることを確認します。

```bash
ssh ubuntu@<VPSホスト>
```

つながらない場合は、公開鍵（`~/.ssh/id_ed25519.pub` など）を管理者に渡して登録してもらってください。ここが通らないと、この先の手順はすべて失敗します。

## 2. リポジトリを用意する

```bash
git clone https://github.com/nagomen/tabi-plan.git
cd tabi-plan
npm install
```

`npm install` は 3 つのワークスペース（`frontend` / `api` / `contracts`）の依存をまとめて入れ、あわせて Git フックを有効にします（`core.hooksPath` = `.githooks`）。フックについては「5. 変更を送る」を参照してください。

## 3. `.env` を作る

```bash
cp .env.sample .env
```

`.env` の中で、実際に書き換えるのは次の 4 つだけです。他の項目は既定値のままで動きます。

| キー | 値 | 理由 |
| --- | --- | --- |
| `DB_PORT` | `3310` | SSH トンネルがローカル側で待ち受けるポート。VPS 上の 3306 へ転送される |
| `DB_PASSWORD` | VPS の `~/secure_env/travel-api.env` からコピー | MySQL の `travelapp` ユーザーのパスワード |
| `LOCAL_DB_SSH_TARGET` | `ubuntu@<VPSホスト>` | トンネルを張る先 |
| `LOCAL_DB_AUTO_MIGRATE` | `0` | 下記の注意を参照 |

`LOCAL_DB_AUTO_MIGRATE` を既定の `1` のままにすると、`dev:full` の起動のたびに DB マイグレーションが**本番 DB に対して**実行されます。冪等な DDL なので壊れはしませんが、手元の起動が本番スキーマを変更するのは避けたいので `0` にしておきます。スキーマを変更する作業をするときだけ、意識的に戻してください。

空のままでよい項目のうち、迷いやすいものは次の 2 つです。

- `SESSION_SECRET` — 空にしておくと、`dev:full` が端末ごとの開発用の値を `.env.local-session-secret`（git 管理外）に生成して使い回します。
- `OPENAI_KEY` — 空でかまいません。AI 機能は、アプリのマイページで自分の OpenAI API キーを登録すれば使えます。料金は登録したキーの OpenAI プロジェクトに計上されます。

`.env` は `.gitignore` 済みです。コミットしないでください。

## 4. 起動する

```bash
npm run dev:full
```

SSH トンネル → API → Vite の順に起動し、`http://localhost:5173/plans.html` が入口になります。終了は `Ctrl+C` です。
ポート競合やトンネルを省略したい場合の挙動は [local-development.md](local-development.md) にまとまっています。

フロントの見た目だけを触るときは、DB も API も要らない `npm run dev` で足ります。

### つながらないとき

| 症状 | 見るところ |
| --- | --- |
| トンネルで止まる | `ssh ubuntu@<VPSホスト>` が単体で通るか。通らなければ鍵の登録待ち |
| `SESSION_SECRET は32文字以上` で API が落ちる | `dev:full` 以外で API を直接起動している。`npm run dev:full` を使う |
| 画面は出るがデータが空 | API が DB に到達できていない。`.env` の `DB_PORT` が `3310` になっているか |

その他の症状は [../README.md](../README.md) のトラブルシュートの表にあります。

## 5. 変更を送る

`main` へ直接 push する運用です。PR は、レビューしてほしいときだけ使います。

```bash
git add -A
git commit -m "feat: 要約"
git push origin main
```

push の直前に pre-push フックが `npm run ci`（型検査・Lint・テスト・本番ビルド）を実行し、失敗したら push を中止します。1 分ほどかかりますが、`main` への push はそのまま本番デプロイに流れるため、ここが唯一のゲートです。`--no-verify` で飛ばさないでください。

コミットメッセージは `type: 要約`（50 文字以内、`type` は `feat` / `fix` / `docs` / `refactor` / `test` / `chore`）で、本文には「なぜ」を書きます。コーディング規約は [../CLAUDE.md](../CLAUDE.md) にまとまっています。

## 6. 次に読むもの

| ドキュメント | 内容 |
| --- | --- |
| [architecture.md](architecture.md) | 画面構成、権限モデル、費用精算、地図 |
| [local-development.md](local-development.md) | `dev:full` の詳細、ローカルデータの扱い |
| [error-contract.md](error-contract.md) | API エラーの共通形式とフロントでの扱い |
| [deploy.md](deploy.md) | デプロイの流れとワークフロー |
| [ai-consultation.md](ai-consultation.md) | AI 旅行相談、API キーの扱い |
