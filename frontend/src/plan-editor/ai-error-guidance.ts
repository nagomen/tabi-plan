export type AiErrorPhase = "candidates" | "itinerary";
export type AiErrorAction = "retry" | "revise" | "restart" | "sign_in" | "contact_support";

export interface AiErrorLike {
  message?: string;
  status?: number;
  code?: string;
  retryAfter?: number;
  retryable?: boolean;
  action?: string;
  requestId?: string;
}

export interface AiErrorGuidance {
  title: string;
  message: string;
  action: AiErrorAction;
  actionLabel: string;
  retryAfter: number;
  requestId: string;
}

const REVISE_CODES = new Set([
  "ai_content_filtered",
  "ai_input_too_large",
  "ai_output_too_long",
  "ai_refused",
  "payload_too_large",
]);
const SUPPORT_CODES = new Set([
  "ai_access_denied",
  "ai_authentication_failed",
  "ai_internal_error",
  "ai_model_unavailable",
  "ai_quota_exceeded",
  "ai_request_invalid",
  "ai_unavailable",
]);
const RETRY_CODES = new Set([
  "ai_cancelled",
  "ai_cooldown",
  "ai_daily_limit",
  "ai_empty_response",
  "ai_incomplete",
  "ai_invalid_response",
  "ai_network_failed",
  "ai_rate_limited",
  "ai_response_failed",
  "ai_timeout",
  "ai_unexpected_status",
  "ai_upstream_failed",
  "client_network_failed",
  "client_offline",
  "client_timeout",
  "db_unavailable",
  "invalid_ai_output",
  "request_failed",
  "server_busy",
  "too many requests",
]);

function fallbackMessage(error: AiErrorLike): string {
  return typeof error.message === "string" && error.message.trim()
    ? error.message.trim()
    : "AI旅行相談を完了できませんでした。";
}

/** APIの内部コードを、利用者が次の操作を選べる画面契約へ変換する。 */
export function aiErrorGuidance(error: AiErrorLike, phase: AiErrorPhase): AiErrorGuidance {
  const code = String(error.code || "request_failed");
  const retryAfter = Math.max(0, Math.ceil(Number(error.retryAfter) || 0));
  const requestId = String(error.requestId || "").slice(0, 128);
  const message = fallbackMessage(error);

  if (code === "session_required" || error.action === "sign_in") {
    return { title: "再ログインが必要です", message, action: "sign_in", actionLabel: "別タブで再ログイン", retryAfter: 0, requestId };
  }
  if (code === "invalid_ai_input" || error.action === "restart_consultation") {
    return phase === "itinerary"
      ? { title: "相談条件が変わりました", message, action: "restart", actionLabel: "候補選びからやり直す", retryAfter: 0, requestId }
      : { title: "入力内容を確認してください", message, action: "revise", actionLabel: "入力を修正する", retryAfter: 0, requestId };
  }
  if (REVISE_CODES.has(code) || error.action === "revise_input") {
    return { title: "条件を調整してください", message, action: "revise", actionLabel: "入力を修正する", retryAfter: 0, requestId };
  }
  if (SUPPORT_CODES.has(code) || error.action === "contact_support") {
    return { title: "管理者による確認が必要です", message, action: "contact_support", actionLabel: "", retryAfter: 0, requestId };
  }
  if (RETRY_CODES.has(code) || error.retryable || error.action === "retry" || error.action === "retry_later" || error.status === 429 || Number(error.status) >= 500) {
    return {
      title: retryAfter ? "しばらく待って再試行してください" : "もう一度試せます",
      message,
      action: "retry",
      actionLabel: phase === "candidates" ? "候補をもう一度作る" : "行程をもう一度作る",
      retryAfter,
      requestId,
    };
  }
  return { title: "AI旅行相談を完了できませんでした", message, action: "contact_support", actionLabel: "", retryAfter: 0, requestId };
}

export function retryWaitLabel(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds));
  if (value < 60) return `${value}秒`;
  const minutes = Math.ceil(value / 60);
  if (minutes < 60) return `約${minutes}分`;
  return `約${Math.ceil(minutes / 60)}時間`;
}
