# デプロイ

| workflow | 用途 | トリガー | 反映先 |
| --- | --- | --- | --- |
| `CI`(`ci.yml`) | 検証 | PR / `main` への push | なし |
| `Deploy Frontend`(`deploy-pages.yml`) | production | `main` への push / 手動 | GitHub Pages |
| `Deploy API`(`deploy-api.yml`) | production | 手動 | API VPS |

## フロント

`.github/workflows/deploy-pages.yml` は `main` に push された `frontend/` を検査・ビルドし、出力 `frontend/dist` を GitHub Pages にデプロイします。
デプロイ後はコミット識別子と主要ファイルを実 URL で検証します。

`main` はブランチ保護で PR 必須のため、フロントのデプロイは「PR をマージする」ことで行われます。

## API

`.github/workflows/deploy-api.yml` は手動実行です。テスト後にソースを VPS へ同期し、DB マイグレーション、API 再起動、日次バックアップタイマーの更新を行います。
必要な Secrets / Variables は [../infra/README.md](../infra/README.md) を参照してください。

## ワンコマンドで全てデプロイ

PR を `main` にマージした後、リポジトリのルートで次を実行します。

```bash
npm run deploy:production
```

- GitHub CLI(`gh`)でログイン済みである必要があります。
- 作業ツリーと `origin/main` との一致を確認し、`Deploy API` と `Deploy Frontend` を起動します。
- 両方の完了を待ち、公開サイトのコミット識別子と AI API の疎通まで検証します。
- コミットや push は自動では行いません。
- 途中でいずれかのデプロイまたは本番確認が失敗した場合は、終了コード 1 で停止します。
