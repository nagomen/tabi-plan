# デプロイ

## ChatGPT MCP（香港・マカオ・金門旅行）

- MCP URL: `https://travel-api.vote-jt.com/mcp`
- OAuth認可画面: GitHub Pages の `mcp-authorize.html`
- 認証・トークン・費用更新: VPS API
- 対象旅行: `2026-hong-kong-macau-kinmen` にサーバー側で固定

`main` への push で、認可画面は Deploy Frontend、MCP/OAuth/API/nginx は Deploy API から配布される。MCPは既存のTabi Planログインを使い、対象旅行の owner/editor にだけ費用書き込みを許可する。

| workflow | 用途 | トリガー | 反映先 |
| --- | --- | --- | --- |
| `CI`(`ci.yml`) | 検証 | PR / `main` への push | なし |
| `Deploy Frontend`(`deploy-pages.yml`) | production | `main` への push / 手動 | GitHub Pages |
| `Deploy API`(`deploy-api.yml`) | production | `main` のAPI関連変更／手動 | API VPS |

## フロント

`.github/workflows/deploy-pages.yml` は `main` に push された `frontend/` を検査・ビルドし、出力 `frontend/dist` を GitHub Pages にデプロイします。
デプロイ後はコミット識別子と主要ファイルを実 URL で検証します。

`main` へ直接 push すればそのままデプロイされます。PR を使った場合はマージ時に同じ流れになります。
push 直前には pre-push フックが `npm run ci` を実行するため、ビルドの通らない変更は手元で止まります。

## API

`.github/workflows/deploy-api.yml` は `main` の `api/`・`contracts/`・`infra/`・依存関係変更で自動実行されます。必要なら手動でも実行できます。テスト後にソースを VPS へ同期し、DB マイグレーション、API 再起動、日次バックアップタイマーの更新を行います。
必要な Secrets / Variables は [../infra/README.md](../infra/README.md) を参照してください。

## ワンコマンドで全てデプロイ

`main` へ push(または PR をマージ)した後、リポジトリのルートで次を実行します。

```bash
npm run deploy:production
```

- GitHub CLI(`gh`)でログイン済みである必要があります。
- 作業ツリーと `origin/main` との一致を確認し、`Deploy API` と `Deploy Frontend` を起動します。
- 両方の完了を待ち、公開サイトのコミット識別子と AI API の疎通まで検証します。
- コミットや push は自動では行いません。
- 途中でいずれかのデプロイまたは本番確認が失敗した場合は、終了コード 1 で停止します。
