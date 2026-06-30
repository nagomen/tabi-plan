# data/

開発中のローカルデータ置き場。

- `plans/<slug>.json` — 計画エディタが保存するローカルプラン（dev のみ）。
  Vite dev サーバが `/api/plans` 経由で読み書きし、ページ読込時に
  `window.__DEV_PLANS__` として注入して localStorage を再構築する。
  本番ビルドには含まれない（将来は DB へ移行）。

- `store/<key>.json` — プラン以外のドメインデータ（ユーザー情報・費用・送金リンク）。
  `src/shared/backend.ts` が `/api/store/<key>` 経由で write-through し、ページ読込時に
  `window.__DEV_STORE__` として注入される。1キー=1ファイル。例:
  `trip-dashboard-user.json`, `trip-dashboard-pay-links.json`,
  `trip-dashboard-expenses-<slug>.json`。

いずれも **dev（`npm run dev`）専用** の仕組み。本番（GitHub Pages = 静的）は
サーバーが無いため書き込めず、データは localStorage に保存される。将来 `backend.ts` を
API/DB 実装へ差し替えると、dev/本番ともに同じバックエンドへ保存できる。

`plans/*.json`・`store/*.json` は個人データになりうるため既定で gitignore。共有したい場合は
`.gitignore` の該当行を外してコミットする。
