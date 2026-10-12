// 返済共有ページ専用の通信。ログインや共有ストアを持たない独立ページなので shared/db.ts は使わず、
// 共通エラー契約（docs/error-contract.md）の message / retryable / retry_after / request_id だけを解釈する。

declare global {
  interface Window {
    TRIP_CONFIG?: { sharedBackend?: { apiBaseUrl?: string } };
  }
}

const TIMEOUT_MS = 30_000;

export class DebtViewerError extends Error {
  constructor(
    message: string,
    readonly title = "返済計画を表示できませんでした",
    readonly retryable = false,
    readonly retryAfter = 0,
    readonly requestId = "",
  ) {
    super(message);
    this.name = "DebtViewerError";
  }
}

/** 応答本文が契約どおりでないとき（HTMLの502など）に、HTTPステータスから利用者向けの説明を作る。 */
function statusFallback(status: number): { title: string; message: string; retryable: boolean } {
  if (status === 404) {
    return {
      title: "共有リンクを確認できませんでした",
      message: "この共有リンクは無効か、公開が終了しています。",
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      title: "アクセスが集中しています",
      message: "試行回数が上限に達しました。しばらく待ってからもう一度お試しください。",
      retryable: true,
    };
  }
  if (status === 403) {
    return {
      title: "このページからは読み込めません",
      message: "このアクセス元からの利用は許可されていません。共有されたURLから開き直してください。",
      retryable: false,
    };
  }
  if (status >= 500) {
    return {
      title: "サーバーに接続できませんでした",
      message: "サーバーが一時的に応答していません。しばらくしてからもう一度お試しください。",
      retryable: true,
    };
  }
  return {
    title: "返済計画を表示できませんでした",
    message: `読み込みに失敗しました（${status}）。ページを再読み込みしてください。`,
    retryable: true,
  };
}

function titleForCode(code: string, status: number): string {
  if (code === "not_found") return "共有リンクを確認できませんでした";
  if (code === "data_corrupted") return "返済計画のデータに問題があります";
  if (code === "db_unavailable" || code === "server_busy") return "サーバーに接続できませんでした";
  if (status === 429) return "アクセスが集中しています";
  return statusFallback(status).title;
}

/** HTTPエラー応答を DebtViewerError に変換する。本文が JSON でなくても必ず日本語で説明する。 */
export function errorFromResponse(status: number, text: string, retryAfterHeader: string | null): DebtViewerError {
  const fallback = statusFallback(status);
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* プロキシのHTMLエラーページなど。fallback を使う */ }
  const message = typeof body.message === "string" && body.message ? body.message : fallback.message;
  const code = typeof body.error === "string" ? body.error : "";
  const retryable = typeof body.retryable === "boolean" ? body.retryable : fallback.retryable;
  const retryAfter = Math.max(0, Math.ceil(Number(body.retry_after ?? retryAfterHeader) || 0));
  const requestId = typeof body.request_id === "string" ? body.request_id.slice(0, 64) : "";
  return new DebtViewerError(message, titleForCode(code, status), retryable, retryAfter, requestId);
}

/** fetch 自体が失敗したとき（オフライン・タイムアウト・CORS拒否・DNS失敗）の説明。 */
export function errorFromNetwork(error: unknown, online: boolean): DebtViewerError {
  const name = (error as { name?: string } | null)?.name || "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new DebtViewerError(
      "サーバーから時間内に応答がありませんでした。通信状態を確認してもう一度お試しください。",
      "通信がタイムアウトしました",
      true,
    );
  }
  if (!online) {
    return new DebtViewerError(
      "インターネットに接続されていません。接続を確認してからもう一度お試しください。",
      "オフラインです",
      true,
    );
  }
  return new DebtViewerError(
    "サーバーへ接続できませんでした。通信状態を確認して、しばらくしてからもう一度お試しください。",
    "サーバーに接続できませんでした",
    true,
  );
}

/** AbortSignal.timeout が無い古い Safari / アプリ内ブラウザでも打ち切れるようにする。 */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  if (typeof AbortController === "undefined") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function apiBase(): string {
  return String(window.TRIP_CONFIG?.sharedBackend?.apiBaseUrl || "").replace(/\/+$/, "");
}

export async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const base = apiBase();
  if (!base) {
    // trip-config.js が読めなかった（キャッシュ不整合・広告ブロッカー等）。相対URLへ投げても GitHub Pages の404になるだけ。
    throw new DebtViewerError(
      "接続先の設定を読み込めませんでした。ページを再読み込みしてください。",
      "ページを準備できませんでした",
      true,
    );
  }
  let response: Response;
  try {
    response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: timeoutSignal(TIMEOUT_MS),
    });
  } catch (error) {
    throw errorFromNetwork(error, typeof navigator === "undefined" || navigator.onLine !== false);
  }
  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    // 本文の受信中に切れた（モバイル回線の切り替えなど）。
    throw errorFromNetwork(error, typeof navigator === "undefined" || navigator.onLine !== false);
  }
  if (!response.ok) throw errorFromResponse(response.status, text, response.headers.get("Retry-After"));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DebtViewerError(
      "サーバーの応答を読み取れませんでした。しばらくしてからもう一度お試しください。",
      "返済計画を表示できませんでした",
      true,
    );
  }
}
