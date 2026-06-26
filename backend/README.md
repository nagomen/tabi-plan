# Apps Script Backend

GitHub Pages から呼ぶデータ API です。Google Sheets を非公開のまま読み、表示してよい JSON だけ返します。パスワード認証、費用入力、レシート写真アップロード、行程編集、精算完了ログを担当します。

## 新しい旅行のセットアップ

1. Apps Script で新規プロジェクトを作る
2. `Code.gs` と `appsscript.json` を反映する
3. `initialSetup()` の `CHANGE_ME_*` を編集するか、別の一時関数から `setupTripDashboard({ ... })` を呼ぶ
4. `setupPlanningSheets()` を実行して必要なシートを作る
5. 必要なら `setTripLinks(myMapsUrl, "", photosUrl)` を実行する
6. レシート写真アップロードを使うなら `authorizeDriveAccess()` を実行する
7. Web App としてデプロイする
8. 発行された Web App URL を `docs/trip-config.js` の `appsScriptUrl` に入れる

```js
function setupForThisTrip() {
  setupTripDashboard({
    password: "共有パスワード",
    spreadsheetId: "YOUR_SPREADSHEET_ID",
    tripSlug: "2703-taiwan",
    tripTitle: "2027年3月台湾旅行",
    dateStart: "2027-03-10",
    dateEnd: "2027-03-15",
    defaultParticipants: ["参加者A", "参加者B"],
    receiptFolderName: "2703-taiwan-receipts"
  });
}
```

`SpreadsheetApp.openById` を使うため、マニフェストのスコープは `https://www.googleapis.com/auth/spreadsheets` にしています。Web App の匿名アクセス時には Google の承認画面を出せないため、初回は Apps Script エディタ上で手動実行して承認してください。

## 反映

`Code.gs` または `appsscript.json` を変更した場合は、必ず Apps Script 本体へ push します。

```bash
cd apps-script
npx clasp push
```

Web App のデプロイ設定を変える必要がある変更では、push 後に Apps Script 画面で新しいデプロイを作成、または既存デプロイを更新してください。

## シート

`setupPlanningSheets()` は次のシートを用意します。

- `基本情報`
- `行程表`
- `参加者`
- `立替ログ`
- `精算完了ログ`
- `為替レート`
- `現地実用情報`
- `リンク管理`
- `チェックリスト`
- `フォーム設計`
- `必要なもの`

`基本情報` の `key / value` を編集すると、旅行名、旅行期間、参加者表示、共有メモ、My Maps URL、Google Photos URL が反映されます。予約番号、宿泊先住所、緊急連絡先、保険証券番号などは公開 JSON に含めない前提で管理してください。

## 行程表

公開ページは `表示時刻`、`表示タイトル`、`表示場所`、`表示メモ`、`必要情報` を優先します。予約番号や宿泊先住所のような詳細は管理列に残し、公開ページには当日見る短い情報だけ入れてください。`公開ページに表示` を `FALSE` にした行は JSON に出しません。

`docs/itinerary-editor.html` から更新できる列は、`表示時刻`、`表示タイトル`、`表示場所`、`表示メモ`、`必要情報`、`地図検索`、`緯度`、`経度`、`天気`、`公開ページに表示` です。

## 参加者と割り勘

`参加者` シートの有効な表示名を、費用入力と精算計算に使います。`立替ログ` に `個別金額_参加者名` 列がなければ、保存時に自動追加します。

普段の入力は `全員で等分` で足ります。一部メンバーだけの支払いは `選んだ人だけで等分`、負担額が人ごとに違う場合は `個別金額を入力` を使います。`精算不要` の行は費用総額には含め、送金計算からは外します。

## 為替と現地情報

国内旅行では `JPY` のまま入力できます。海外旅行では `為替レート` シートに `日付 / 通貨 / 円換算レート` を入れると、支払日以前の最新レートで JPY 換算します。

`現地実用情報` は国ごとの通貨、ATM、配車、支払いメモを入れる任意シートです。初期状態ではヘッダーだけ作り、特定地域の古い情報は自動投入しません。

## レシート写真

`authorizeDriveAccess()` を実行すると、`TRIP_RECEIPT_FOLDER_NAME` または `tripSlug-receipts` の Google Drive フォルダを使います。既存フォルダを使う場合は Script Properties の `TRIP_RECEIPT_FOLDER_ID` にフォルダ ID を設定してください。アップロードしたファイルをリンク共有にする場合は `TRIP_RECEIPT_PUBLIC_LINKS=true` を設定します。
