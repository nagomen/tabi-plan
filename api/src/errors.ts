export class BadRequest extends Error {}

export class Forbidden extends Error {}

export class NotFound extends Error {}

export class VersionConflict extends Error {
  constructor(message: string, readonly currentVersion = 0) {
    super(message);
  }
}

/** 全レスポンス共通のエラー契約。フロントの ApiRequestError が解釈する。 */
export interface ErrorBody {
  error: string;
  message: string;
  retryable: boolean;
  retry_after?: number;
  action: "retry" | "retry_later" | "revise_input" | "reload" | "contact_support" | "sign_in";
  request_id?: string;
  current_version?: number;
}

/** 再試行で解消しうるMySQL・接続層のエラーコード。 */
const TRANSIENT_DB_CODES = new Set([
  "ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_CON_COUNT_ERROR", "ER_TOO_MANY_USER_CONNECTIONS",
]);
const DB_UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND",
  "PROTOCOL_CONNECTION_LOST", "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR", "PROTOCOL_ENQUEUE_AFTER_QUIT",
]);
const INVALID_INPUT_DB_CODES = new Set([
  "ER_DATA_TOO_LONG", "ER_TRUNCATED_WRONG_VALUE", "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD",
  "ER_WARN_DATA_OUT_OF_RANGE", "ER_BAD_NULL_ERROR", "ER_WRONG_VALUE",
]);

/**
 * ルーティング外へ漏れた例外を、内部情報を出さずに利用者契約へ変換する。
 * AI系は routes.ts の aiFailure が先に処理するため、ここへは来ない。
 */
export function describeError(error: unknown, requestId: string): { status: number; body: ErrorBody } {
  const message = error instanceof Error ? error.message : String(error);
  const code = String((error as { code?: string })?.code || "");

  if (message === "PAYLOAD_TOO_LARGE") {
    return {
      status: 413,
      body: {
        error: "payload_too_large",
        message: "送信データが大きすぎます。画像や本文を減らしてお試しください。",
        retryable: false,
        action: "revise_input",
      },
    };
  }
  if (message === "INVALID_JSON") {
    return {
      status: 400,
      body: {
        error: "invalid_json",
        message: "送信データを読み取れませんでした。画面を読み込み直してお試しください。",
        retryable: false,
        action: "reload",
      },
    };
  }
  if (error instanceof BadRequest) {
    return {
      status: 400,
      body: { error: "bad_request", message, retryable: false, action: "revise_input" },
    };
  }
  if (error instanceof Forbidden) {
    return {
      status: 403,
      body: { error: "forbidden", message, retryable: false, action: "reload" },
    };
  }
  if (error instanceof NotFound) {
    return {
      status: 404,
      body: { error: "not_found", message, retryable: false, action: "reload" },
    };
  }
  if (error instanceof VersionConflict) {
    return {
      status: 409,
      body: {
        error: "plan_version_conflict",
        message: "計画が別の端末で更新されています。最新の内容を読み込み直してから、もう一度保存してください。",
        retryable: false,
        action: "reload",
        ...(error.currentVersion ? { current_version: error.currentVersion } : {}),
      },
    };
  }
  if (code === "ER_DUP_ENTRY") {
    // フロントが slug 衝突の自動リトライにこのコードを使うため、error は変えない。
    return {
      status: 409,
      body: {
        error: "ER_DUP_ENTRY",
        message: "同じ内容が既に登録されています。画面を読み込み直して確認してください。",
        retryable: false,
        action: "reload",
        request_id: requestId,
      },
    };
  }
  if (code.startsWith("ER_NO_REFERENCED_ROW") || code.startsWith("ER_ROW_IS_REFERENCED") ||
      code === "ER_CHECK_CONSTRAINT_VIOLATED") {
    return {
      status: 409,
      body: {
        error: "conflict",
        message: "操作の対象が別の端末で変更されています。画面を読み込み直してお試しください。",
        retryable: false,
        action: "reload",
        request_id: requestId,
      },
    };
  }
  if (INVALID_INPUT_DB_CODES.has(code)) {
    return {
      status: 400,
      body: {
        error: "invalid_input",
        message: "入力内容を保存できませんでした。日付・数値・文字数を確認してください。",
        retryable: false,
        action: "revise_input",
        request_id: requestId,
      },
    };
  }
  if (TRANSIENT_DB_CODES.has(code)) {
    return {
      status: 503,
      body: {
        error: "server_busy",
        message: "サーバーが混み合っています。少し待ってからもう一度お試しください。",
        retryable: true,
        retry_after: 3,
        action: "retry_later",
        request_id: requestId,
      },
    };
  }
  if (DB_UNAVAILABLE_CODES.has(code) || message === "Queue limit reached" || message === "Pool is closed.") {
    return {
      status: 503,
      body: {
        error: "db_unavailable",
        message: "データの保存先に接続できません。しばらくしてからもう一度お試しください。",
        retryable: true,
        retry_after: 10,
        action: "retry_later",
        request_id: requestId,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: "internal error",
      message: "サーバーでエラーが発生しました。続く場合は問い合わせ番号を添えて管理者へお知らせください。",
      retryable: false,
      action: "contact_support",
      request_id: requestId,
    },
  };
}
