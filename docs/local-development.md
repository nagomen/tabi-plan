# ローカル開発

## `npm run dev:full` の動作

`.env.sample` を元に `.env` を作り、DB / API の値を設定したうえで実行します。

```bash
npm run dev:full
```

このコマンドは次を順番に起動し、`http://localhost:5173/plans.html` を入口として表示します。

1. MySQL への SSH トンネル
2. 後方互換な DB マイグレーション
3. ローカル API と、その TypeScript 監視ビルド
4. Vite

フロントの `/api` は Vite 経由でローカル API へ転送されるため、本番 API の CORS 設定や Vite のポート自動変更には依存しません。終了は `Ctrl+C` です。

| 状況 | 挙動と設定 |
| --- | --- |
| 5173 が使用中 | 空いている次のポートを選び、実際の URL をターミナルに表示する |
| `SESSION_SECRET` を省略 | git 管理外の `.env.local-session-secret` を初回だけ生成して再利用する。API を再起動してもブラウザのログインセッションは維持される。本番では必ず環境変数で固定値を設定する |
| 既に DB へ直接接続できる | `.env` で `LOCAL_DB_TUNNEL=0` を指定する |
| マイグレーションを別途管理する | `LOCAL_DB_AUTO_MIGRATE=0` で起動時の適用を無効化する |

## ローカルデータ

`data/` はローカル開発専用のデータ置き場です。本番の正は MySQL の関係テーブルで、`sharedBackend.mode` が `"api"` のときは読まれません。
詳細は [../data/README.md](../data/README.md) を参照してください。

## 旧 KV データの移行

旧 `kv_store` テーブルが残っている環境では、API を経由せず関係テーブルへ一度だけ移行できます。

```bash
node api/scripts/migrate-kv-to-relational.mjs --dry-run
node api/scripts/migrate-kv-to-relational.mjs --reset
```
