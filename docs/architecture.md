# アプリ構成

## 画面

| ページ | エントリ | 役割 | 主な利用者 |
| --- | --- | --- | --- |
| `frontend/plans.html` | `src/plans/main.ts` | 旅行計画の一覧・選択ハブ | 計画を選ぶ・作る人 |
| `frontend/plan-editor.html` | `src/plan-editor/main.ts` | 旅行計画の新規作成・編集(行程まで) | 計画を組み立てる人 |
| `frontend/index.html` | `src/dashboard/main.ts` | 共有ダッシュボード | 旅行メンバー全員 |
| `frontend/mypage.html` | `src/mypage/main.ts` | アカウント、友達、旅行履歴 | ログインユーザー |
| `frontend/person.html` | `src/person/main.ts` | 人物ページ | ログインユーザー |
| `frontend/login.html` | `src/login/main.ts` | ログイン | 全員 |

各画面とも `public/trip-config.js`(`window.TRIP_CONFIG`)を読み込み、共有 TS(`src/shared/config.ts`、`src/shared/plans-store.ts`)を import します。

## 動作モード

| 用途 | モード | データ保存 | ページからの書き込み |
| --- | --- | --- | --- |
| デザイン確認 | `sample` | なし | 不可 |
| 本番運用 | `local` + `sharedBackend.mode: "api"` | MySQL | 可 |

`mode: "local"` はアプリ内で作成した共同計画を表し、計画・行程・チェックリスト・費用を MySQL API に保存します。
端末には選択中の slug だけを `trip-dashboard-active-plan` として保存し、計画本体は保存しません。

## 旅行計画の作成と選択

`frontend/plans.html` が複数の旅行計画を束ねる入口です。`src/shared/plans-store.ts` が MySQL API の関係テーブルを画面用のモデルへ変換します。

| 操作 | 画面 | 保存先 |
| --- | --- | --- |
| 計画を作る・編集する | `plan-editor.html` | MySQL API |
| 計画を選んで開く | `plans.html` から `index.html?plan=<slug>` へ | 選択中 slug を localStorage に記録 |
| 公開済み旅行を見る | `index.html` | MySQL API |

## 共同計画と共有

旅行を計画してシェアする本番用途では、`sharedBackend.mode: "api"` の MySQL API を正とします。

| 目的 | 仕組み | 使い方 |
| --- | --- | --- |
| 別端末で同じ計画を見る | MySQL API | ログイン後、公開計画または自分が参加する計画を取得 |
| 招待リンクで参加する | `plans.html#join=...` | owner が発行した期限付きトークンをログイン済みユーザーが受諾 |
| 候補・投票・費用を残す | 関係テーブル | `user_id` と `plan_id` を正にして API へ保存 |
| 権限を守る | API セッション + `plan_members` | ブラウザの任意の userId ではなく、サーバーセッションから利用者を確定 |

## 権限モデル

権限の正本は `plan_members` です。`role` は `owner` / `editor` / `viewer`、`status` は `active` / `left` / `revoked` です。

| ロール | 閲覧 | 計画本文 | 費用・精算 | メンバー・公開設定・招待 |
| --- | --- | --- | --- | --- |
| viewer | 可 | 不可 | 不可 | 不可 |
| editor | 可 | 可 | 可 | 不可 |
| owner | 可 | 可 | 可 | 可 |

- `public` かつ `published` の計画は未ログインでも公開部分を閲覧できます。限定公開・下書き・費用・精算・タスクは正式メンバーだけに返します。
- `open_editing` は既定で無効です。有効化した場合もログイン済み非メンバーが変更できるのは公開本文だけです。
- 計画メタ・本文の保存には `plans.version` を使った楽観ロックがあり、別端末で先に更新されていた場合は 409 を返します。
- 費用の作成・更新・削除・復元は `expense_audit_logs` に変更前後と実行者を保存します。

## 参加者と費用

参加者、費用、精算は MySQL API へ保存します。参加者は `plan_members` で管理し、表示名ではなくユーザー ID を正として扱います。

| 分担方法 | 使う場面 |
| --- | --- |
| 全員で等分 | 通常 |
| 選んだ人だけで等分 | 一部メンバーだけの支出 |
| 個別金額を入力 | 個別の負担額が違う場合 |
| 精算不要 | 支払者本人の費用には含め、送金計算からは外す |

## 地図

地図は行程に保存した緯度経度から自動で表示範囲を決めます。国内、海外、複数国の旅程でも地域固定の bounds は使いません。
緯度経度がない予定は地図検索リンクで補助します。
