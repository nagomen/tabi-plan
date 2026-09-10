# エラー契約

API のエラーは全経路で共通の形を返します。

```json
{ "error": "...", "message": "...", "retryable": false, "retry_after": 0, "action": "...", "request_id": "..." }
```

| フィールド | 内容 |
| --- | --- |
| `error` | 機械判定用のコード |
| `message` | 利用者へそのまま表示できる日本語 |
| `retryable` | 再試行で解決しうるか |
| `retry_after` | 再試行までの秒数(503 のときだけ) |
| `action` | フロントが取る行動。`retry` / `retry_later` / `revise_input` / `restart_consultation` / `use_external_ai` / `reload` / `contact_support` / `sign_in` のいずれか |
| `request_id` | サーバーログと突き合わせる ID。全レスポンスの `X-Request-Id` ヘッダにも付く |

分類は `api/src/errors.ts` の `describeError`、AI 系は `api/src/ai-errors.ts` が行います。

## サーバー側の挙動

- DB のデッドロックは自動再試行します。
- 接続断・キュー超過は `retry_after` 付きの 503 になります。

## フロント側の挙動

- `frontend/src/shared/db.ts` の `ApiRequestError` が `action` を解釈します。
- 全リクエストに打ち切り時間があります(AI 90 秒、他 30 秒)。
- 投げっぱなしの書き込み失敗と読み込み失敗は `trip-sync-error` イベント経由で画面上部の帯(`frontend/src/shared/session-notice.ts`)に表示されます。
- 計画の 409(版の衝突)では、相手の変更を上書きしないよう自動保存を止めて読み込み直しを促します。
