# data/

**ローカル開発専用**のデータ置き場。本番の正は MySQL（共有ストア API）。

- `plans/<slug>.json` — 計画エディタが保存するローカルプラン。
  Vite dev サーバが `/api/plans` 経由で読み書きし、ページ読込時に
  `window.__DEV_PLANS__` として注入して localStorage を再構築する。
- `store/<key>.json` — プラン以外のドメインデータ（アカウント・権限・費用・送金リンクなど）。
  `src/shared/backend.ts` が `/api/store/<key>` 経由で write-through し、
  `window.__DEV_STORE__` として注入される。1キー=1ファイル。

どちらも Vite プラグインが `apply: "serve"` なので **本番ビルドには含まれない**。

## 共有ストア API を使っているときは読まれない

`trip-config.js` の `sharedBackend.mode` が `"api"` のときは、こちらのファイルは
一切当てない（`Backend.sharedApiEnabled()` で抑止）。DB が正なのに古いファイルを
当てると、ページを開くたびに共有中のデータを上書きしてしまうため。

## DB へ入れる

ここのファイルを共有ストアへ流し込むには、移行スクリプトを使う。

```bash
API_BASE=https://travel-api.example.com API_TOKEN=xxxx \
  node api/scripts/seed-from-data.mjs          # 既存キーはスキップ
  #                                --force     # 既存も上書き
```

`plans/*.json` と `store/*.json` は個人データを含むため gitignore している
（アカウントのメールアドレスやパスワードハッシュが入る）。
