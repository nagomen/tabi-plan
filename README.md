# 2026年8月 東北旅行 Dashboard

2026年8月1日から8月9日までの東北旅行用ダッシュボードです。観光地を一筆書き寄りにつなぎ、夜に大きい祭りがある日は祭りを見るルートにしています。

GitHub Pages には予約番号、宿泊先住所、電話番号、保険証券番号などを置かないでください。現在は Google Sheets をリンク閲覧可にして `googleSheets` モードで読み取る試作構成です。非公開運用やページからの書き込みが必要になったら、Apps Script Web App 経由に切り替えます。

## 旅行情報

| 項目 | 内容 |
| --- | --- |
| 期間 | 2026年8月1日から2026年8月9日 |
| 方針 | 祭りを全部拾う旅ではなく、観光地をつないで夜に大きい祭りがある日は祭りを見る |
| ルート | 東京、平泉、盛岡、八戸、青森、弘前、五所川原、秋田、庄内、山形、山寺、仙台、松島、東京 |
| データ元 | [2608 東北旅行ダッシュボード](https://docs.google.com/spreadsheets/d/1Vsed92F7ao0rW0y5WWao_6VOasuqwATVH1GwE7MvsXw/edit) |
| 公開方式 | GitHub Pages + Google Sheets 直接読み取り |

## ルート

| 日付 | ルート | 昼の観光 | 夜 |
| --- | --- | --- | --- |
| 8/1(土) | 東京 → 平泉 → 盛岡 | 平泉で中尊寺、毛越寺 | 盛岡さんさ踊り |
| 8/2(日) | 盛岡 → 八戸 | 種差海岸、蕪島あたり | 八戸三社大祭 |
| 8/3(月) | 八戸 → 青森 | 三内丸山遺跡、ねぶたの家 | 青森ねぶた祭 |
| 8/4(火) | 青森 → 弘前 → 五所川原 | 弘前城、洋館、喫茶店 | 五所川原立佞武多 |
| 8/5(水) | 五所川原、弘前 → 秋田 | 五能線か奥羽本線で南下 | 秋田竿燈まつり |
| 8/6(木) | 秋田 → 酒田、鶴岡 | 山居倉庫、羽黒山、加茂水族館 | 庄内泊で休む |
| 8/7(金) | 鶴岡、酒田 → 山形 | 移動、余裕があれば山形市内 | 山形花笠まつり |
| 8/8(土) | 山形 → 山寺 → 仙台、松島 | 山寺、仙台七夕、または松島 | 仙台泊 |
| 8/9(日) | 仙台、松島 → 東京 | 松島を見て帰京 | なし |

## ディレクトリ構成

`frontend`（Vite + TypeScript の公開サイト）と `backend`（clasp + TypeScript の Apps Script）に分けています。

```
frontend/                 公開サイト（Vite + TypeScript, マルチページ）
  index.html              共有ダッシュボード（slim。中身は src/dashboard/main.ts）
  plans.html / plan-editor.html / expense-entry.html / itinerary-editor.html
  public/                 ビルドを通さない静的ファイル（trip-config.js, sw.js, icon-*, *.webmanifest）
  src/
    shared/               全画面共有の TS（types.ts / config.ts / plans-store.ts）
    dashboard/ plans/ plan-editor/ expense-entry/ itinerary-editor/  各ページの main.ts
  vite.config.ts / tsconfig.json / package.json
backend/                  Apps Script（clasp + TypeScript）
  src/Code.ts             バックエンド本体（global scope。import/export は使わない）
  src/appsscript.json
  .clasp.json.example     scriptId を入れて .clasp.json にコピーする
  tsconfig.json / package.json
tools/                    補助スクリプト（build-trip-config.js, hash-password.js）
sheet-template/           Google Sheets の初期データ CSV
```

### 開発コマンド

npm workspaces 構成です。**ルートで `npm install` 1回**で frontend / backend 両方の依存が入ります（lockfile はルートの `package-lock.json` 1枚）。以降はすべてリポジトリのルートで実行します。

| コマンド | 用途 |
| --- | --- |
| `npm install` | frontend + backend をまとめて導入 |
| `npm run dev` | フロントのローカル開発サーバ（Vite） |
| `npm run build` | フロントを型検査してビルド（`tsc --noEmit` + `vite build`、出力 `frontend/dist`） |
| `npm run typecheck` | frontend と backend の両方を型検査 |
| `npm run push` | clasp で Apps Script へ反映（要 `backend/.clasp.json`） |

個別に動かしたい場合は `npm run <script> -w frontend` / `-w backend`、または各ディレクトリに入って従来どおり実行もできます。

## 構成

| 用途 | 推奨モード | Google Sheets の公開範囲 | ページからの書き込み | 向いている場面 |
| --- | --- | --- | --- | --- |
| デザイン確認 | `sample` | 不要 | 不可 | Google Sheets をまだ作っていない段階 |
| 読み取りだけの試作 | `googleSheets` | リンクを知っている全員が閲覧可 | 不可 | 公開してよい行程、予算、リンクをすぐ表示したい場合 |
| 本番運用 | `appsScript` | 非公開のままで可 | 可 | 立替入力、行程編集、レシート保存、パスワード認証を使う場合 |

## 新しい旅行で使う手順

| 手順 | 作業場所 | やること | 補足 |
| --- | --- | --- | --- |
| 1 | 旅行 repo | `frontend/public/trip-config.example.js` を参考に `frontend/public/trip-config.js` を編集する | `tripSlug` は旅行ごとに必ず変える |
| 2 | Apps Script | `setupTripDashboard({ ... })` を実行する | `appsScript` モードを使う場合。読み取り試作だけなら省略可 |
| 3 | Apps Script | Web App としてデプロイする | 発行された URL を `appsScriptUrl` に入れる |
| 4 | ローカル | ルートで `npm run build` を実行する | Pages に出す前に型検査とビルドで確認する |
| 5 | GitHub | `main` に push する | Actions がビルド後に Pages へ公開する |

`tripSlug` は localStorage のキーに使います。旅行ごとに必ず変えてください。

```js
window.TRIP_CONFIG = {
  tripSlug: "2703-taiwan",
  tripTitle: "2027年3月台湾旅行",
  mode: "appsScript",
  spreadsheetId: "YOUR_SPREADSHEET_ID",
  schema: "trip",
  appsScriptUrl: "https://script.google.com/macros/s/.../exec",
  defaultParticipants: ["参加者A", "参加者B"],
  currencies: ["JPY", "TWD", "USD"]
};
```

## GitHub Pages 自動デプロイ

`.github/workflows/deploy-pages.yml` は、`main` に push された `frontend/` を Vite でビルドし、出力 `frontend/dist` を GitHub Pages に自動デプロイします。`npm run build`（`tsc --noEmit` + `vite build`）が型検査とビルドを兼ねます。

| トリガー | ビルド対象 | 事前チェック | 初回だけ必要な設定 |
| --- | --- | --- | --- |
| `main` への push（`frontend/**`） | `frontend/dist` | `npm run build`（型検査＋ビルド） | 旅行 repo の Settings > Pages で Source を `GitHub Actions` にする |
| 手動実行 | `frontend/dist` | `npm run build` | Actions タブから `Deploy GitHub Pages` を実行する |

旅行ごとに repo を分ける場合は、`frontend/public/trip-config.js` をその repo にコミットする運用で十分です。コミットしたくない場合だけ、GitHub の Repository variables に `TRIP_CONFIG_JSON` を設定してください。workflow 実行時に `tools/build-trip-config.js` が `frontend/public/trip-config.js` を生成します。

| 変数 | 例 | 公開可否 |
| --- | --- | --- |
| `TRIP_CONFIG_JSON` | `{"tripSlug":"2703-taiwan","tripTitle":"2027年3月台湾旅行","mode":"appsScript","schema":"trip","spreadsheetId":"...","appsScriptUrl":"https://script.google.com/macros/s/.../exec","defaultParticipants":["A","B"],"currencies":["JPY","TWD"]}` | Pages に含まれるため公開情報として扱う |

`TRIP_CONFIG_JSON` に共有パスワード、予約番号、宿泊先住所、緊急連絡先、保険証券番号は入れないでください。

## 画面

| ページ | エントリ | 役割 | 主な利用者 |
| --- | --- | --- | --- |
| `frontend/plans.html` | `src/plans/main.ts` | 旅行計画の一覧・選択ハブ | 計画を選ぶ・作る人 |
| `frontend/plan-editor.html` | `src/plan-editor/main.ts` | 旅行計画の新規作成・編集（行程まで） | 計画を組み立てる人 |
| `frontend/index.html` | `src/dashboard/main.ts` | 共有ダッシュボード | 旅行メンバー全員 |
| `frontend/expense-entry.html` | `src/expense-entry/main.ts` | スマホ向け費用入力 | 立替を入力する人 |
| `frontend/itinerary-editor.html` | `src/itinerary-editor/main.ts` | 公開表示用の行程編集 | 行程を管理する人 |

各画面とも `public/trip-config.js`（`window.TRIP_CONFIG`）を読み込み、共有 TS（`src/shared/config.ts`, `src/shared/plans-store.ts`）を import します。Apps Script URL や localStorage キーを各 HTML に直書きしない運用です。

## 旅行計画の作成と選択

`frontend/plans.html` が複数の旅行計画を束ねる入口です。`src/shared/plans-store.ts` がレジストリ（プラン一覧と各ローカルプランのデータ）を localStorage に保存します。

| 操作 | 画面 | 保存先 |
| --- | --- | --- |
| 計画を作る・編集する | `plan-editor.html` | この端末（ブラウザ）の localStorage |
| 計画を選んで開く | `plans.html` → `index.html?plan=<slug>` | 選択中 slug を localStorage に記録 |
| 公開済み旅行を見る | `index.html` | Google Sheets / Apps Script |

- 既存の `window.TRIP_CONFIG`（東北旅行など Sheets 連携の旅行）は、初回に「組み込みプラン」として一覧へ自動登録されます。従来どおりの表示は維持されます。
- `mode: "local"` のプランは行程・地図・チェックリスト・リンクをこの端末だけで表示します。費用入力と精算は Google Sheets / Apps Script 連携の旅行で使えます。
- レジストリのキー: `trip-dashboard-plans`（一覧）、`trip-dashboard-plan-<slug>`（各データ）、`trip-dashboard-active-plan`（選択中）。
- **開発時のファイル保存**：`npm run dev` の Vite サーバが、ローカルプランを `data/plans/<slug>.json` に読み書きします（保存時に自動で書き出し、ページ読込時に `window.__DEV_PLANS__` として注入して localStorage を再構築）。**ファイルが真実**なので別ブラウザでも同じ内容になり、Git で差分も見られます。本番ビルドには含まれません（将来は DB へ移行）。`data/plans/*.json` は既定で gitignore。

### 計画エディタの場所検索

エディタの「地図を検索」は、既定では無料の **OpenStreetMap（Nominatim）** を使います。これは OSM に現地語で登録された地名・施設に強い一方、海外のホテル等を**日本語名**で引くのは苦手です（例:「プラザホテル ニューヨーク」はヒットしない）。

多言語の施設検索を使いたい場合は、`frontend/public/trip-config.js` に **Mapbox の公開トークン**を設定します。設定すると検索が Mapbox Search Box（多言語POI）に切り替わり、空なら自動で Nominatim にフォールバックします。

```js
window.TRIP_CONFIG = {
  // …
  geocoding: { mapboxToken: "pk.xxxxx" } // https://account.mapbox.com/ の Access tokens（無料枠あり）
};
```

トークンはクライアントに露出する公開トークンです。Mapbox 側で URL 制限をかけて利用してください。座標が分かっている場合は、予定を開いて「地図で指定」→ 地図クリックでも登録できます。

### ローカルプランを公開する（Google Sheets へ書き出し）

`plans.html` の各ローカルプランにある「公開」ボタンは、Apps Script の `createTrip` を呼び、行程を新しい Google スプレッドシートへ書き出します。書き出し後はそのプランが `googleSheets` 連携に切り替わり、リンクを知っている人と共有できます。

| 前提 | 内容 |
| --- | --- |
| デプロイ | `backend/src/Code.ts` を最新にして Web App をデプロイし、発行 URL を `frontend/public/trip-config.js` の `appsScriptUrl` に設定する |
| 認証 | `createTrip` は共有パスワード（`TRIP_PASSWORD_HASH`）で保護されます。公開時にパスワードを求められます |
| 共有 | 作成したスプレッドシートは「リンクを知っている全員が閲覧可」に自動設定されます（組織ポリシーで失敗した場合は手動で設定） |

`appsScriptUrl` が未設定だと「公開」ボタンは案内メッセージのみを表示します。Apps Script を更新したら反映のため再デプロイしてください。

```bash
cd backend
npx clasp push
```

## Google Sheets

Apps Script が読む主なシートは次のとおりです。

| シート | 役割 | 公開ページでの扱い |
| --- | --- | --- |
| `基本情報` | 旅行名、期間、共有メモ、My Maps URL、Google Photos URL | `公開ページに表示` が `TRUE` の項目だけ使う |
| `行程表` | 表示時刻、表示タイトル、表示場所、表示メモ、必要情報、緯度経度、公開可否 | `公開ページに表示` が `FALSE` の行は出さない |
| `参加者` | 参加者ID、表示名、有効、精算比率、既定通貨 | 有効な表示名を費用入力と精算に使う |
| `立替ログ` | 費用入力ページから保存される立替明細 | 集計と精算額に使う |
| `精算完了ログ` | サイト上で精算完了にした送金ペア | 完了済みペアを精算候補から外す |
| `為替レート` | 外貨を JPY 換算するための手入力レート | 支払日以前の最新レートを使う |
| `現地実用情報` | 海外旅行での通貨、ATM、配車、支払いメモ | 任意。国内旅行では空に近くてよい |
| `リンク管理` | 予約表、予算表、写真アルバムなどのリンク | 表示対象リンクだけ出す |
| `チェックリスト` | 出発前、旅行中の確認事項 | 未完了項目を表示する |
| `予算` | 予算カテゴリ、金額、通貨 | 予算カードに使う |
| `予約管理` | 航空券、宿、移動、ツアーなど | 予約状況の一覧に使う |

国内旅行では `為替レート` と `現地実用情報` は空に近い運用で構いません。海外旅行では支払日以前の最新レートを `為替レート` に入れると、費用集計と精算額に反映されます。

## 参加者と費用

参加者は `参加者` シートから読みます。`立替ログ` の `個別金額_名前` 列は、保存時に Apps Script が不足分を自動追加します。参加者が変わる旅行でも、HTML や Apps Script のコードを書き換える必要はありません。

通常は `全員で等分` を選びます。一部メンバーだけなら `選んだ人だけで等分`、個別の負担額が違う場合は `個別金額を入力` を使います。`精算不要` の行は支払者本人の費用には含め、送金計算からは外します。

## 地図

地図は `行程表` の緯度経度から自動で表示範囲を決めます。国内、海外、複数国の旅程でも、南米のような地域固定の bounds は使いません。緯度経度がない行は `地図検索` と Google Maps リンクで補助します。

## 公開範囲

GitHub Pages は公開サイトとして扱うのが安全です。ページに出してよい情報だけを Apps Script が返す設計にしてください。非公開情報は Google Sheets 側で管理し、`公開ページに表示` を `FALSE` にします。

Apps Script 側を変更した場合は、GitHub へ push するだけでは反映されません。

```bash
cd backend
npx clasp push
```
