# Tabi Plan

旅行の計画・共有ダッシュボードアプリです。行程・地図・チェックリスト・費用精算を仲間と共有できます。共有データの正本は MySQL API です。

静的ファイルに含めた情報は公開情報として扱ってください。予約番号、宿泊先住所、電話番号、保険証券番号などの機密は置かず、非公開データは API 側の認可で制御します。GitHub Pages はプレビュー、本番は GitHub Actions から nginx 配信先へデプロイする運用を推奨します。

## ディレクトリ構成

`frontend`（Vite + TypeScript の公開サイト）、`api`（Node.js + MySQL）、`contracts`（共有DTO）に分けています。

```
frontend/                 公開サイト（Vite + TypeScript, マルチページ）
  index.html              共有ダッシュボード（slim。中身は src/dashboard/main.ts）
  plans.html / plan-editor.html / mypage.html / login.html
  public/                 ビルドを通さない静的ファイル（trip-config.js, sw.js, icon-*, *.webmanifest）
  src/
    shared/               全画面共有の TS（types.ts / config.ts / plans-store.ts）
    dashboard/ plans/ plan-editor/  各ページの main.ts
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
tools/                    補助スクリプト（build-trip-config.js, hash-password.js）
```

### 開発コマンド

npm workspaces 構成です。**ルートで `npm install` 1回**で frontend / api の依存が入ります（lockfile はルートの `package-lock.json` 1枚）。以降はすべてリポジトリのルートで実行します。

| コマンド | 用途 |
| --- | --- |
| `npm install` | frontend + api をまとめて導入 |
| `npm run dev` | フロントのローカル開発サーバ（Vite） |
| `npm run build` | フロントを型検査してビルド（`tsc --noEmit` + `vite build`、出力 `frontend/dist`） |
| `npm run typecheck` | frontend / api をすべて型検査 |
| `npm test` | frontend / API のテスト |
| `npm run ci` | 全ワークスペース型検査 + APIテスト + 本番フロントビルド |
| `npm run build:api` | APIを `api/dist` へコンパイル |

個別に動かしたい場合は `npm run <script> -w frontend` / `-w api`、または各ディレクトリに入って実行できます。

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

行程生成は`OPENAI_TIMEOUT_MS`（既定80秒）まで応答にかかります。長い行程を最後まで構造化出力できるよう
`OPENAI_MAX_OUTPUT_TOKENS`は既定30,000で、機械用JSONの推論量は`OPENAI_REASONING_EFFORT=none`を既定とします。
APIの前段に置くリバースプロキシの
読み取りタイムアウトはこれより長くしてください（`infra/nginx/travel-api.conf.template`は90秒）。
短いとプロキシが先に切断し、CORSヘッダの無いエラーになるため、ブラウザでは「AIサーバーへ接続
できませんでした」と表示されます。Cloudflare経由の場合は同社のプロキシ上限（約100秒）未満に収めます。

### エラー契約

APIのエラーは全経路で共通の形
`{ error, message, retryable, retry_after?, action, request_id? }`
を返します（分類は`api/src/errors.ts`の`describeError`、AI系は`api/src/ai-errors.ts`）。
`message`は利用者へそのまま表示できる日本語、`action`は`retry / retry_later / revise_input /
restart_consultation / reload / contact_support / sign_in`のいずれかで、フロントの
`ApiRequestError`（`frontend/src/shared/db.ts`）が解釈します。全レスポンスに`X-Request-Id`が付き、
サーバーログと突き合わせられます。DBのデッドロックは自動再試行し、接続断・キュー超過は
`retry_after`付きの503になります。フロント側は全リクエストに打ち切り時間（AI 90秒・他 30秒）があり、
投げっぱなしの書き込み失敗と読み込み失敗は`trip-sync-error`イベント経由で画面上部の帯
（`frontend/src/shared/session-notice.ts`）に表示されます。計画の409（版の衝突）では、相手の変更を
上書きしないよう自動保存を止めて読み込み直しを促します。

## 構成

| 用途 | モード | データ保存 | ページからの書き込み |
| --- | --- | --- | --- |
| デザイン確認 | `sample` | なし | 不可 |
| 本番運用 | `local` + `sharedBackend.mode: "api"` | MySQL | 可 |

## 新しい旅行で使う手順

| 手順 | 作業場所 | やること | 補足 |
| --- | --- | --- | --- |
| 1 | 旅行 repo | `frontend/public/trip-config.example.js` を参考に `frontend/public/trip-config.js` を編集する | `tripSlug` は旅行ごとに必ず変える |
| 2 | ローカル | ルートで `npm run ci` を実行する | 型検査・テスト・ビルドを確認する |
| 3 | GitHub | `main` に push する | Actions が Pages を更新する |
| 4 | GitHub | `Deploy Production` を手動実行する | APIと静的ファイルをVPSへ反映する |

`tripSlug` は localStorage のキーに使います。旅行ごとに必ず変えてください。

```js
window.TRIP_CONFIG = {
  tripSlug: "2703-taiwan",
  tripTitle: "2027年3月台湾旅行",
  mode: "local",
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

`.github/workflows/deploy-pages.yml` は preview 用です。`main` に push された `frontend/` を Vite でビルドし、出力 `frontend/dist` を GitHub Pages にデプロイします。

`.github/workflows/deploy-production.yml` は本番用です。手動実行で、まずAPIをビルドしてDBマイグレーションとサービス再起動を行い、成功後に `frontend/dist` をnginxの配信先へatomicに反映します。`install_nginx` を有効にする場合は Repository variable `PRODUCTION_API_DOMAIN` も設定してください。

| workflow | 用途 | トリガー | 反映先 |
| --- | --- | --- | --- |
| `Deploy Preview Pages` | preview | push / 手動 | GitHub Pages |
| `Deploy Production` | production | 手動 | nginx VPS |

旅行ごとに repo を分ける場合は、`frontend/public/trip-config.js` をその repo にコミットする運用で十分です。コミットしたくない場合だけ、GitHub の Repository variables に `TRIP_CONFIG_JSON` を設定してください。本番だけ設定を変える場合は `PRODUCTION_TRIP_CONFIG_JSON` を使います。

| 変数 | 例 | 公開可否 |
| --- | --- | --- |
| `TRIP_CONFIG_JSON` | `{"tripSlug":"2703-taiwan","tripTitle":"2027年3月台湾旅行","mode":"local","defaultParticipants":["A","B"],"currencies":["JPY","TWD"],"sharedBackend":{"enabled":true,"mode":"api","apiBaseUrl":"","apiToken":""}}` | Pages に含まれるため公開情報として扱う |
| `PRODUCTION_TRIP_CONFIG_JSON` | 本番用の同形式設定 | nginx 配信物に含まれるため公開情報として扱う |

`TRIP_CONFIG_JSON` に共有パスワード、予約番号、宿泊先住所、緊急連絡先、保険証券番号は入れないでください。

## 画面

| ページ | エントリ | 役割 | 主な利用者 |
| --- | --- | --- | --- |
| `frontend/plans.html` | `src/plans/main.ts` | 旅行計画の一覧・選択ハブ | 計画を選ぶ・作る人 |
| `frontend/plan-editor.html` | `src/plan-editor/main.ts` | 旅行計画の新規作成・編集（行程まで） | 計画を組み立てる人 |
| `frontend/index.html` | `src/dashboard/main.ts` | 共有ダッシュボード | 旅行メンバー全員 |

各画面とも `public/trip-config.js`（`window.TRIP_CONFIG`）を読み込み、共有 TS（`src/shared/config.ts`, `src/shared/plans-store.ts`）を import します。

## 旅行計画の作成と選択

`frontend/plans.html` が複数の旅行計画を束ねる入口です。`src/shared/plans-store.ts` は MySQL API の関係テーブルを画面用のモデルへ変換します。

| 操作 | 画面 | 保存先 |
| --- | --- | --- |
| 計画を作る・編集する | `plan-editor.html` | MySQL API |
| 計画を選んで開く | `plans.html` → `index.html?plan=<slug>` | 選択中 slug を localStorage に記録 |
| 公開済み旅行を見る | `index.html` | MySQL API |

- `mode: "local"` はアプリ内で作成した共同計画を表し、計画・行程・チェックリスト・費用を MySQL API に保存します。
- 選択中の slug だけを端末固有の `trip-dashboard-active-plan` に保存します。計画本体は端末に保存しません。

### 共同計画・共有の本番運用

旅行を計画してシェアする本番用途では、`sharedBackend.mode: "api"` の MySQL API を正とします。

| 目的 | 仕組み | 使い方 |
| --- | --- | --- |
| 別端末で同じ計画を見る | MySQL API | ログイン後、公開計画または自分が参加する計画を取得 |
| 招待リンクで参加する | `plans.html#join=...` | owner が発行した期限付きトークンをログイン済みユーザーが受諾 |
| 候補・投票・費用を残す | 関係テーブル | `user_id` と `plan_id` を正にしてAPIへ保存 |
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

## 参加者と費用

参加者、費用、精算はMySQL APIへ保存します。参加者は`plan_members`で管理し、表示名ではなくユーザーIDを正として扱います。

通常は `全員で等分` を選びます。一部メンバーだけなら `選んだ人だけで等分`、個別の負担額が違う場合は `個別金額を入力` を使います。`精算不要` の行は支払者本人の費用には含め、送金計算からは外します。

## 地図

地図は行程に保存した緯度経度から自動で表示範囲を決めます。国内、海外、複数国の旅程でも地域固定の bounds は使いません。緯度経度がない予定は地図検索リンクで補助します。

## 公開範囲

GitHub Pages と nginx のどちらでも、静的ファイルは公開情報です。ページに出してよい設定だけを `trip-config.js` に入れ、非公開計画・参加者・費用・招待は API 側の認可で制御してください。
