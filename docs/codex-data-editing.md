# Codexから旅行データを編集する

旅行データの正本は本番MySQLです。通常の行程変更は、ログイン済みの計画エディタを標準Chromeから操作します。APIの認可、入力検査、版管理がそのまま働くためです。

複数行をまとめて直す場合だけ、`plan:data` を使います。公開APIからの取得と、SSHトンネル経由のDB操作を別コマンドに分けています。

## 公開データの確認

```bash
npm run plan:data -- public-export --plan trip-8
npm run plan:data -- public-export --plan 中国旅行 --out /tmp/china-trip.public.json
```

公開取得には認証が要りません。ただし、非公開リンク、チェックリスト、候補、費用、メンバーは含まれません。出力には `scope: "public"` が付き、DBへの適用には使えません。

## DBの完全な行程を取得

先にSSHトンネルを張ります。

```bash
ssh -N -T -L 3310:127.0.0.1:3306 ubuntu@163.44.121.146
npm run build:api
npm run plan:data -- db-actors --plan trip-8
npm run plan:data -- db-export --plan trip-8 --actor <user_id> --out /tmp/china-trip.db.json
```

`db-actors` は対象旅行で有効な editor と owner の利用者IDだけを表示します。`actor` はこの結果から選び、曖昧な表示名から推測しません。

## 行程をまとめて反映

エクスポートJSONの `content` だけを編集します。対象は行程、訪問地、リンク、チェックリスト、候補です。

まず検査と差分件数だけを表示します。

```bash
npm run plan:data -- db-apply --file /tmp/china-trip.db.json --actor <user_id>
```

内容、対象plan ID、現在版が一致していることを確認してから反映します。

```bash
npm run plan:data -- db-apply --file /tmp/china-trip.db.json --actor <user_id> --commit
```

反映直前のデータは `.codex-data-backups/` に保存されます。更新後はもう一度 `db-export` を実行し、意図した行だけが変わったことを確認します。版が進んでいた場合は処理が止まるため、新しく取得し直して差分を作り直します。

費用、精算、メンバー、権限、招待はこの一括編集の対象外です。それぞれのAPIまたは画面を使い、監査ログと権限処理を保ちます。
