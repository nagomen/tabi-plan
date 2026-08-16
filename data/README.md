# data/

**ローカル開発専用**のデータ置き場。本番の正は MySQL の関係テーブルです。

- `store/<key>.json` — プラン以外のドメインデータ（アカウント・権限・費用・送金リンクなど）。
  `src/shared/backend.ts` が `/api/store/<key>` 経由で write-through し、
  `window.__DEV_STORE__` として注入される。1キー=1ファイル。

Vite プラグインが `apply: "serve"` なので **本番ビルドには含まれない**。旅行計画の正本はローカル開発でも MySQL であり、`data/plans` は使用しない。

## 共有ストア API を使っているときは読まれない

`trip-config.js` の `sharedBackend.mode` が `"api"` のときは、こちらのファイルは
一切当てない（`Backend.sharedApiEnabled()` で抑止）。DB が正なのに古いファイルを
当てると、ページを開くたびに共有中のデータを上書きしてしまうため。

## 旧KVデータをDBへ移行する

旧 `kv_store` テーブルが残っている環境では、APIを経由せず関係テーブルへ一度だけ移行できます。

```bash
node api/scripts/migrate-kv-to-relational.mjs --dry-run
node api/scripts/migrate-kv-to-relational.mjs --reset
```

`store/*.json` は個人データを含むため gitignore している
（アカウントのメールアドレスやパスワードハッシュが入る）。
