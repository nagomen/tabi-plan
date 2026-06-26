# data/

開発中のローカルデータ置き場。

- `plans/<slug>.json` — 計画エディタが保存するローカルプラン（dev のみ）。
  Vite dev サーバが `/api/plans` 経由で読み書きし、ページ読込時に
  `window.__DEV_PLANS__` として注入して localStorage を再構築する。
  本番ビルドには含まれない（将来は DB へ移行）。

`plans/*.json` は個人データになりうるため既定で gitignore。共有したい場合は
`.gitignore` の該当行を外してコミットする。
