# Codexから旅行データを直接編集する

旅行データの正本は本番MySQLです。CodexはSSHトンネル経由で、ブラウザを使わずに旅程、訪問地、リンク、チェックリスト、候補を取得、編集できます。

費用、精算、メンバー、権限、招待は対象外です。監査ログや専用の権限処理があるため、それぞれのAPIを使います。

## DBの完全な内容を取得する

別ターミナルでSSHトンネルを維持します。

```bash
ssh -N -T -L 3310:127.0.0.1:3306 ubuntu@163.44.121.146
npm run build:api
npm run plan:data -- db-actors --plan trip-8
npm run plan:data -- db-export --plan trip-8 --actor <user_id> --out /tmp/china-trip.db.json
```

`db-actors` は対象旅行で有効なownerとeditorだけを表示します。actor IDはこの結果から選び、表示名から推測しません。

エクスポートJSONの `content` だけを編集します。`scope: "database"`、plan ID、version、actor IDは変更しません。

## 差分を検査して反映する

最初は `--commit` を付けず、件数と変更行だけを確認します。

```bash
npm run plan:data -- db-apply --file /tmp/china-trip.db.json --actor <user_id>
```

対象旅行、版、変更行が正しければ反映します。

```bash
npm run plan:data -- db-apply --file /tmp/china-trip.db.json --actor <user_id> --commit
```

反映前の完全な内容は `.codex-data-backups/` に保存されます。更新は既存APIと同じ入力検査、権限確認、楽観ロック、トランザクションを通り、反映後にDBを再取得して一致を確認します。DBのversionが進んでいる場合は停止するため、新しくエクスポートして差分を作り直します。

## 公開範囲だけ確認する

接続確認だけなら公開APIを使えます。

```bash
npm run plan:data -- public-export --plan trip-8
```

この出力は `scope: "public"` で、非公開情報を含まず、DBへ適用できません。
