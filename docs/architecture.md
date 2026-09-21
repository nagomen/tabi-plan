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
| 招待リンクで参加する | `plans.html#join=...` | owner または editor が発行した期限付きトークンをログイン済みユーザーが受諾 |
| 候補・投票・費用を残す | 関係テーブル | `user_id` と `plan_id` を正にして API へ保存 |
| 権限を守る | API セッション + `plan_access_grants` | ブラウザの任意の userId ではなく、サーバーセッションと受諾済み権限から利用者を確定 |

## 権限モデル

旅行参加者の正本は `plan_members`、アプリへのアクセス権の正本は `plan_access_grants` です。`plan_members.display_name` は旅行内だけの表示名で、`users.display_name` のアカウント名とは独立しています。参加予定者を先に費用・日程へ登録しても、招待を受諾して `plan_access_grants.status = active` になるまでは限定情報へアクセスできません。`plans.owner_user_id` を所有者の正本とし、owner のアクセス行は同じ更新処理内で同期します。

| ロール | 限定情報の閲覧 | 計画・費用の変更 | 招待リンクの発行・取消 | 参加者名簿・公開設定 |
| --- | --- | --- | --- | --- |
| viewer | 可 | 不可 | 不可 | 不可 |
| editor | 可 | 可 | 可 | 不可 |
| owner | 可 | 可 | 可 | 可 |

- `public` かつ `published` の計画は未ログインでも公開部分を閲覧できます。限定公開・下書き・費用・精算・タスクは受諾済みメンバーだけに返します。
- 旧 `open_editing` 列は互換性のため残しますが、認可には使いません。公開計画も変更には受諾済みの owner/editor 権限が必要です。
- アクセス停止は `plan_members` を残して `plan_access_grants` と対象者別の未使用招待だけを失効します。費用・精算の履歴を壊さず、ownerが即時に閲覧・編集を止められます。
- 脱退時もアクセス権は必ず失効し、会計参照がない場合だけ参加者行を `left` にします。会計参照がある場合は履歴用の参加者行を残します。
- 表示名だけの共通招待は相手のアカウントを限定しない bearer link です。登録済みユーザーを限定する招待では `invited_user_id` を必須にします。
- 招待の発行・取消は editor にも許します。人を呼ぶたびに owner を待たせないためで、editor は招待できても参加者名簿（追加・削除・権限・参加期間）は変更できません。招待された人が参加者になるのは、本人がリンクを受諾した時点です。
- 計画メタ・本文の保存には `plans.version` を使った楽観ロックがあり、別端末で先に更新されていた場合は 409 を返します。
- 費用の作成・更新・削除・復元は `expense_audit_logs` に変更前後と実行者を保存します。

## 参加者と費用

参加者、費用、精算は MySQL API へ保存します。参加者は `plan_members` で管理し、同一人物の判定にはユーザー ID、画面表示には旅行内表示名を使います。本人は旅行ごとに表示名を変更できますが、アカウント名は変わりません。

| 分担方法 | 使う場面 |
| --- | --- |
| 全員で等分 | 通常 |
| 選んだ人だけで等分 | 一部メンバーだけの支出 |
| 個別金額を入力 | 個別の負担額が違う場合 |
| 精算不要 | 支払者本人の費用には含め、送金計算からは外す |

外貨の費用は、支払日、支払通貨、計画の基準通貨が完全一致する履歴レートで換算します。土日祝日も前営業日へずらさず、支払日の暦日を指定して取得します。初回だけ外部の履歴為替APIから取得して `exchange_rates` に保存し、同じ組み合わせは保存済みの値を再利用します。配信元が指定日と同じ日付のレートを返せない場合は登録を止め、近い営業日のレートを別の日へ流用しません。通常表示や再集計でも外部APIへ再問い合わせしません。

## 地図

地図は行程に保存した緯度経度から自動で表示範囲を決めます。国内、海外、複数国の旅程でも地域固定の bounds は使いません。
緯度経度がない予定は地図検索リンクで補助します。
