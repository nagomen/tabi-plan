# Tabi Plan

旅行の計画・共有ダッシュボードアプリです。行程・地図・チェックリスト・費用精算を仲間と共有できます。ローカル（この端末だけ）でも、MySQL API / Google Sheets / Apps Script 連携でも動作します。旅行ごとに `frontend/public/trip-config.js` を差し替えるだけで、コードを書き換えずに使い回せます。

静的ファイルに含めた情報は公開情報として扱ってください。予約番号、宿泊先住所、電話番号、保険証券番号などの機密は置かず、非公開データは API 側の認可で制御します。GitHub Pages はプレビュー、本番は GitHub Actions から nginx 配信先へデプロイする運用を推奨します。

## ディレクトリ構成

`frontend`（Vite + TypeScript の公開サイト）、`api`（Node.js + MySQL）、`backend`（clasp + TypeScript の Apps Script互換層）に分けています。

```
frontend/                 公開サイト（Vite + TypeScript, マルチページ）
  index.html              共有ダッシュボード（slim。中身は src/dashboard/main.ts）
  plans.html / plan-editor.html / expense-entry.html / itinerary-editor.html
  public/                 ビルドを通さない静的ファイル（trip-config.js, sw.js, icon-*, *.webmanifest）
  src/
    shared/               全画面共有の TS（types.ts / config.ts / plans-store.ts）
    dashboard/ plans/ plan-editor/ expense-entry/ itinerary-editor/  各ページの main.ts
  vite.config.ts / tsconfig.json / package.json
api/                      本番の認証・認可・共有データAPI（Node.js + MySQL）
  src/server.ts           HTTP、CORS、レート制限、セッション解決
  src/routes.ts           認可付きルーティング
  src/db.ts               共有MySQLプールとDB共通処理
  src/auth-repo.ts        認証情報とセッション
  src/user-repo.ts        ユーザー・設定・友達関係
  src/plan-repo.ts        計画・参加者・招待・本文
  src/expense-repo.ts     費用・精算・監査ログ
  ../contracts/           frontend と API が共有する通信DTO
  schema/                 初期スキーマ
  scripts/migrate.mjs     本番差分マイグレーション
backend/                  Apps Script（clasp + TypeScript）
  src/Code.ts             バックエンド本体（global scope。import/export は使わない）
  src/appsscript.json
  .clasp.json.example     scriptId を入れて .clasp.json にコピーする
  tsconfig.json / package.json
tools/                    補助スクリプト（build-trip-config.js, hash-password.js）
sheet-template/           Google Sheets の初期データ CSV
```

### 開発コマンド

npm workspaces 構成です。**ルートで `npm install` 1回**で frontend / api / backend の依存が入ります（lockfile はルートの `package-lock.json` 1枚）。以降はすべてリポジトリのルートで実行します。

| コマンド | 用途 |
| --- | --- |
| `npm install` | frontend + backend をまとめて導入 |
| `npm run dev` | フロントのローカル開発サーバ（Vite） |
| `npm run build` | フロントを型検査してビルド（`tsc --noEmit` + `vite build`、出力 `frontend/dist`） |
| `npm run typecheck` | frontend / api / backend をすべて型検査 |
| `npm test` | APIの権限ポリシーテスト |
| `npm run ci` | 全ワークスペース型検査 + APIテスト + 本番フロントビルド |
| `npm run build:api` | APIを `api/dist` へコンパイル |
| `npm run push` | clasp で Apps Script へ反映（要 `backend/.clasp.json`） |

個別に動かしたい場合は `npm run <script> -w frontend` / `-w api` / `-w backend`、または各ディレクトリに入って実行できます。

### ローカルでフロント・API・MySQLを一括起動

`.env.sample` を元に `.env` を作り、DB/APIの値を設定したうえで次を実行します。

```bash
npm run dev:full
```

このコマンドはMySQLへのSSHトンネル、後方互換なDBマイグレーション、ローカルAPI、APIのTypeScript監視、Viteを順番に起動し、
`http://localhost:5173/plans.html` を入口として表示します。フロントの `/api` はVite経由でローカルAPIへ
転送されるため、本番APIのCORS設定やViteのポート自動変更には依存しません。終了は `Ctrl+C` です。
5173が使用中の場合は、空いている次のポートを選び、実際のURLをターミナルに表示します。
`SESSION_SECRET`を省略したローカル開発では、git管理外の`.env.local-session-secret`を初回だけ生成して再利用します。
そのためAPIを再起動してもブラウザのログインセッションは維持されます。本番では必ず環境変数で固定値を設定してください。

既にDBへ直接接続できる環境では `.env` の `LOCAL_DB_TUNNEL=0` を指定してください。
マイグレーションを別途管理する場合は `LOCAL_DB_AUTO_MIGRATE=0` で起動時の適用を無効化できます。

### AI旅行相談

AI旅行相談は、候補提示と行程確定の2リクエストで終了します。OpenAI APIキーは必ずAPIサーバーの
`OPENAI_KEY`へ設定し、フロントの`trip-config.js`には入れないでください。候補・行程の生成には
Responses APIの構造化出力を使用し、既定ではWeb検索で観光地と都市間移動の実在性を補強します。

主な運用設定は`.env.sample`の`OPENAI_*`と`AI_*`です。利用回数とトークン数は
`ai_usage_daily`へ記録されるため、既存DBでは`npm run migrate -w api`を適用してください。
Web検索を利用できないモデル・環境では`OPENAI_WEB_SEARCH_ENABLED=false`にできますが、候補や移動情報の
根拠が弱くなるため本番では有効を推奨します。

## 構成

| 用途 | 推奨モード | Google Sheets の公開範囲 | ページからの書き込み | 向いている場面 |
| --- | --- | --- | --- | --- |
| デザイン確認 | `sample` | 不要 | 不可 | Google Sheets をまだ作っていない段階 |
| 読み取りだけの試作 | `googleSheets` | リンクを知っている全員が閲覧可 | 不可 | 公開してよい行程、予算、リンクをすぐ表示したい場合 |
| 本番運用 | `sharedBackend.mode: "api"` | API 側の認可で制御 | 可 | 招待、参加者権限、非公開計画、費用精算を使う場合 |
| Apps Script 運用 | `appsScript` | 非公開のままで可 | 可 | スプレッドシート中心で軽く共有する場合 |

## 新しい旅行で使う手順

| 手順 | 作業場所 | やること | 補足 |
| --- | --- | --- | --- |
| 1 | 旅行 repo | `frontend/public/trip-config.example.js` を参考に `frontend/public/trip-config.js` を編集する | `tripSlug` は旅行ごとに必ず変える |
| 2 | Apps Script | `setupTripDashboard({ ... })` を実行する | `appsScript` モードを使う場合。読み取り試作だけなら省略可 |
| 3 | Apps Script | Web App としてデプロイする | 発行された URL を `appsScriptUrl` に入れる |
| 4 | ローカル | ルートで `npm run build` を実行する | push 前に型検査とビルドで確認する |
| 5 | GitHub | `restructure-frontend-backend-ts` に push する | Actions が preview Pages を更新する |
| 6 | GitHub | `Deploy Production` を手動実行する | Actions が build 済み `frontend/dist` を nginx 配信先へ反映する |

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
  currencies: ["JPY", "TWD", "USD"],
  sharedBackend: {
    enabled: true,
    mode: "api",
    apiBaseUrl: "",
    apiToken: ""
  }
};
```

## GitHub Actions デプロイ

`.github/workflows/deploy-pages.yml` は preview 用です。`restructure-frontend-backend-ts` に push された `frontend/` を Vite でビルドし、出力 `frontend/dist` を GitHub Pages にデプロイします。

`.github/workflows/deploy-production.yml` は本番用です。手動実行で、まずAPIをビルドしてDBマイグレーションとサービス再起動を行い、成功後に `frontend/dist` をnginxの配信先へatomicに反映します。`install_nginx` を有効にする場合は Repository variable `PRODUCTION_API_DOMAIN` も設定してください。

| workflow | 用途 | トリガー | 反映先 |
| --- | --- | --- | --- |
| `Deploy Preview Pages` | preview | push / 手動 | GitHub Pages |
| `Deploy Production` | production | 手動 | nginx VPS |

旅行ごとに repo を分ける場合は、`frontend/public/trip-config.js` をその repo にコミットする運用で十分です。コミットしたくない場合だけ、GitHub の Repository variables に `TRIP_CONFIG_JSON` を設定してください。本番だけ設定を変える場合は `PRODUCTION_TRIP_CONFIG_JSON` を使います。

| 変数 | 例 | 公開可否 |
| --- | --- | --- |
| `TRIP_CONFIG_JSON` | `{"tripSlug":"2703-taiwan","tripTitle":"2027年3月台湾旅行","mode":"appsScript","schema":"trip","spreadsheetId":"...","appsScriptUrl":"https://script.google.com/macros/s/.../exec","defaultParticipants":["A","B"],"currencies":["JPY","TWD"]}` | Pages に含まれるため公開情報として扱う |
| `PRODUCTION_TRIP_CONFIG_JSON` | `{"tripSlug":"2703-taiwan","tripTitle":"2027年3月台湾旅行","mode":"local","schema":"trip","sharedBackend":{"enabled":true,"mode":"api","apiBaseUrl":"","apiToken":""}}` | nginx 配信物に含まれるため公開情報として扱う |

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

`frontend/plans.html` が複数の旅行計画を束ねる入口です。`src/shared/plans-store.ts` は MySQL API の関係テーブルを画面用のモデルへ変換します。

| 操作 | 画面 | 保存先 |
| --- | --- | --- |
| 計画を作る・編集する | `plan-editor.html` | MySQL API |
| 計画を選んで開く | `plans.html` → `index.html?plan=<slug>` | 選択中 slug を localStorage に記録 |
| 公開済み旅行を見る | `index.html` | Google Sheets / Apps Script |

- 既存の `window.TRIP_CONFIG`（Sheets 連携の旅行）は、初回に「組み込みプラン」として一覧へ自動登録されます。従来どおりの表示は維持されます。
- `mode: "local"` はアプリ内で作成した共同計画を表し、計画・行程・チェックリスト・費用を MySQL API に保存します。
- Apps Script は Google Sheets 由来の公開旅行データと、そのシートに対する行程・費用更新だけを担当します。ユーザー、権限、共同計画の正本は MySQL API です。
- 選択中の slug だけを端末固有の `trip-dashboard-active-plan` に保存します。計画本体は端末に保存しません。

### 共同計画・共有の本番運用

旅行を計画してシェアする本番用途では、`sharedBackend.mode: "api"` の MySQL API を正とします。Google Sheets は公開してよい読み取りデータ、Apps Script は既存シート連携の互換機能として扱います。

| 目的 | 仕組み | 使い方 |
| --- | --- | --- |
| 別端末で同じ計画を見る | MySQL API | ログイン後、公開計画または自分が参加する計画を取得 |
| 招待リンクで参加する | `plans.html#join=...` | owner が発行した期限付きトークンをログイン済みユーザーが受諾 |
| 候補・投票・費用を残す | 関係テーブル | `user_id` と `plan_id` を正にしてAPIへ保存 |
| 公開用 Sheets に書き出す | `createTrip` | 計画一覧の「公開」で新しい Google スプレッドシートを作成 |
| 権限を守る | APIセッション + `plan_members` | ブラウザの任意のuserIdではなく、サーバーセッションから利用者を確定 |

### 権限モデル

権限の正本は `plan_members` です。`role` は `owner` / `editor` / `viewer`、`status` は `active` / `left` / `revoked` です。

| ロール | 閲覧 | 計画本文 | 費用・精算 | メンバー・公開設定・招待 |
| --- | --- | --- | --- | --- |
| viewer | 可 | 不可 | 不可 | 不可 |
| editor | 可 | 可 | 可 | 不可 |
| owner | 可 | 可 | 可 | 可 |

`public` かつ `published` の計画は未ログインでも公開部分を閲覧できます。限定公開・下書き・費用・精算・タスクは正式メンバーだけに返します。`open_editing` は既定で無効で、有効化した場合もログイン済み非メンバーが変更できるのは公開本文だけです。

計画メタ・本文の保存には `plans.version` を使った楽観ロックがあり、別端末で先に更新されていた場合は409を返します。費用の作成・更新・削除・復元は `expense_audit_logs` に変更前後と実行者を保存します。

### 計画エディタの場所検索

エディタの「検索」は、既定では無料の **OpenStreetMap（Nominatim）** を使います。公開APIの利用規約に従い、Nominatimは検索ボタンを押した明示操作に限り、入力中の自動候補には使いません。検索結果はセッション内でキャッシュし、旅行の国・都市座標を検索範囲へ反映します。

多言語の施設検索と入力中の候補表示を使いたい場合は、`frontend/public/trip-config.js` に **Mapbox の公開トークン**を設定します。設定するとMapbox Search Boxへ切り替わり、AI生成行程が返した住所・地図座標も検索結果で照合します。Mapbox未設定でもAI生成時にWeb検索で確認した住所・座標を保存します。Mapbox障害時に施設名をNominatimへ自動送信することはありません。

```js
window.TRIP_CONFIG = {
  // …
  geocoding: { mapboxToken: "pk.xxxxx" } // https://account.mapbox.com/ の Access tokens（無料枠あり）
};
```

トークンはクライアントに露出する公開トークンです。Mapbox 側で URL 制限をかけて利用してください。都市・場所とも検索結果は自動確定せず、候補を選んで登録します。座標が分かっている場合は、予定を開いて「地図で指定」→ 地図クリックでも登録できます。

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

GitHub Pages と nginx のどちらでも、静的ファイルは公開情報です。ページに出してよい設定だけを `trip-config.js` に入れ、非公開計画・参加者・費用・招待は API 側の認可で制御してください。

Apps Script 側を変更した場合は、GitHub へ push するだけでは反映されません。

```bash
cd backend
npx clasp push
```
