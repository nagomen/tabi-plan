import { config } from "./config.js";
import { AiOutputError, AiUpstreamError, type AiRecoveryAction } from "./ai-errors.js";

const ENDPOINT = "https://api.openai.com/v1/responses";
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);
const QUOTA_CODES = new Set([
  "billing_hard_limit_reached",
  "credit_balance_exhausted",
  "insufficient_quota",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "project_spend_limit_exceeded",
]);
const INPUT_TOO_LARGE_CODES = new Set(["context_length_exceeded", "input_too_large", "request_too_large"]);

interface OpenAiResponse {
  id?: string;
  status?: string;
  error?: { code?: string; type?: string; message?: string; param?: string | null } | null;
  incomplete_details?: { reason?: string } | null;
  output?: {
    type?: string;
    content?: { type?: string; text?: string; refusal?: string }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface OpenAiMeta {
  requestId: string;
  model: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

interface StructuredResponseArgs {
  schemaName: string;
  schema: unknown;
  system: string;
  user: string;
  apiKey?: string;
  userManagedKey?: boolean;
  webSearch?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function retryAfterSeconds(response: Response | null): number {
  const value = response?.headers.get("retry-after") || "";
  const seconds = Number(value);
  if (value && Number.isFinite(seconds) && seconds >= 0) return Math.min(3600, Math.ceil(seconds));
  const retryAt = value ? Date.parse(value) : Number.NaN;
  if (Number.isFinite(retryAt)) return Math.min(3600, Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)));
  return 0;
}

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = retryAfterSeconds(response);
  if (retryAfter > 0) return Math.min(10_000, retryAfter * 1000 + Math.random() * 250);
  return Math.min(5_000, 300 * (2 ** attempt) + Math.random() * 250);
}

function requestIdOf(response: Response | null, data: OpenAiResponse | null): string {
  return response?.headers.get("x-request-id") || data?.id || "";
}

function safeUpstreamDetail(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const error = (value as OpenAiResponse).error;
  return [error?.code, error?.type, error?.param, error?.message]
    .filter(Boolean)
    .join(": ")
    // 認証エラー本文が入力キーの一部を含んでも、サーバーログへ残さない。
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]")
    .slice(0, 500);
}

function classifiedError(response: Response, data: OpenAiResponse | null, userManagedKey = false): AiUpstreamError {
  const status = response.status;
  const code = String(data?.error?.code || "").toLowerCase();
  const upstreamDetail = safeUpstreamDetail(data);
  const detail = `${status}${upstreamDetail ? ` ${upstreamDetail}` : ""}`;
  const requestId = requestIdOf(response, data);
  const retryAfter = retryAfterSeconds(response);
  const options = (extra: {
    retryable?: boolean; action?: AiRecoveryAction; retryAfter?: number;
  } = {}) => ({ ...extra, requestId, causeDetail: detail });

  if (status === 401) {
    return new AiUpstreamError(
      "ai_authentication_failed",
      userManagedKey
        ? "登録したOpenAI APIキーを認証できませんでした。マイページでキーを確認してください。"
        : "AI機能のサーバー設定を確認する必要があります。管理者へお知らせください。",
      options({ action: userManagedKey ? "update_api_key" : "contact_support" }),
    );
  }
  if (status === 403) {
    return new AiUpstreamError(
      "ai_access_denied",
      userManagedKey
        ? "登録したAPIキーではこのAIモデルを利用できません。OpenAIプロジェクトの権限を確認してください。"
        : "このAIモデルまたは接続元を利用できません。管理者へお知らせください。",
      options({ action: userManagedKey ? "update_api_key" : "contact_support" }),
    );
  }
  if (status === 404) {
    return new AiUpstreamError(
      "ai_model_unavailable",
      userManagedKey
        ? "登録したAPIキーでは設定中のAIモデルを利用できません。キーのプロジェクト権限を確認してください。"
        : "設定中のAIモデルを利用できません。管理者へお知らせください。",
      options({ action: userManagedKey ? "update_api_key" : "contact_support" }),
    );
  }
  if (QUOTA_CODES.has(code)) {
    return new AiUpstreamError(
      "ai_quota_exceeded",
      userManagedKey
        ? "OpenAI APIの残高またはプロジェクトの支払い上限に達しています。OpenAI Platformで課金設定を確認してください。"
        : "サービス共通のAI利用枠に達しています。ChatGPTで続けるか、マイページで自分のOpenAI APIキーを登録してください。",
      options({ action: "update_api_key" }),
    );
  }
  if (status === 413 || INPUT_TOO_LARGE_CODES.has(code)) {
    return new AiUpstreamError(
      "ai_input_too_large",
      "旅行条件が長すぎてAIへ送れませんでした。都市数や追加条件を減らしてお試しください。",
      options({ action: "revise_input" }),
    );
  }
  if (status === 400) {
    return new AiUpstreamError(
      "ai_request_invalid",
      "AI機能の設定と送信形式が合っていません。管理者へお知らせください。",
      options({ action: "contact_support" }),
    );
  }
  if (status === 429) {
    return new AiUpstreamError(
      "ai_rate_limited",
      "AIが混み合っています。少し待ってからお試しください。",
      options({ retryable: true, retryAfter, action: "retry_later" }),
    );
  }
  const retryable = RETRYABLE_STATUSES.has(status);
  return new AiUpstreamError(
    status === 408 || status === 504 ? "ai_timeout" : "ai_upstream_failed",
    status === 408 || status === 504
      ? "AIの応答が時間内に完了しませんでした。もう一度お試しください。"
      : retryable
        ? "AIサービスが一時的に利用できません。少し待ってからお試しください。"
        : "AIサービスとの通信に失敗しました。管理者へお知らせください。",
    options({ retryable, retryAfter, action: retryable ? "retry_later" : "contact_support" }),
  );
}

function extractOutput(data: OpenAiResponse, requestId: string, userManagedKey = false): string {
  if (data.status === "failed" || data.error) {
    const code = String(data.error?.code || "").toLowerCase();
    const quota = QUOTA_CODES.has(code);
    throw new AiUpstreamError(
      quota ? "ai_quota_exceeded" : "ai_response_failed",
      quota
        ? userManagedKey
          ? "OpenAI APIの残高またはプロジェクトの支払い上限に達しています。OpenAI Platformで課金設定を確認してください。"
          : "サービス共通のAI利用枠に達しています。ChatGPTで続けるか、マイページで自分のOpenAI APIキーを登録してください。"
        : "AIサービスが行程生成を完了できませんでした。時間を置いてお試しください。",
      {
        retryable: !quota,
        action: quota ? "update_api_key" : "retry_later",
        requestId,
        causeDetail: safeUpstreamDetail(data),
      },
    );
  }
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason || "unknown";
    const filtered = reason === "content_filter";
    const tooLong = reason === "max_output_tokens";
    throw new AiUpstreamError(
      filtered ? "ai_content_filtered" : tooLong ? "ai_output_too_long" : "ai_incomplete",
      filtered
        ? "入力内容の一部をAIが安全上の理由で処理できませんでした。表現を変えてお試しください。"
        : tooLong
          ? "AIの回答が長くなり途中で切れました。外部AI用プロンプトを使うか、条件を少し減らしてお試しください。"
          : "AIの応答が途中で終了しました。もう一度お試しください。",
      {
        retryable: !filtered && !tooLong,
        action: filtered ? "revise_input" : tooLong ? "use_external_ai" : "retry",
        requestId,
        causeDetail: reason,
      },
    );
  }
  if (data.status && data.status !== "completed") {
    throw new AiUpstreamError(
      data.status === "cancelled" ? "ai_cancelled" : "ai_unexpected_status",
      "AIの処理が完了しませんでした。もう一度お試しください。",
      { retryable: true, action: "retry", requestId, causeDetail: data.status },
    );
  }
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "refusal") {
        throw new AiUpstreamError(
          "ai_refused",
          "この条件ではAIが旅行案を作成できませんでした。希望の表現を変えてお試しください。",
          { action: "revise_input", requestId, causeDetail: String(content.refusal || "refusal").slice(0, 500) },
        );
      }
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new AiUpstreamError(
    "ai_empty_response",
    "AIから結果が返りませんでした。もう一度お試しください。",
    { retryable: true, action: "retry", requestId },
  );
}

/**
 * OpenAI Responses APIの唯一の呼び出し口。
 * 保存無効・出力上限・refusal/不完全応答・限定再試行・利用量計測をここで統一する。
 */
export async function structuredResponse<T>(args: StructuredResponseArgs): Promise<{ value: T; meta: OpenAiMeta }> {
  const fetchImpl = args.fetchImpl || fetch;
  const sleep = args.sleep || ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = Date.now();
  const deadline = startedAt + config.ai.timeoutMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= config.ai.maxRetries; attempt += 1) {
    let response: Response | null = null;
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new DOMException("AI request timed out", "TimeoutError");
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${args.apiKey ?? config.ai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.ai.model,
          instructions: args.system,
          input: [{ role: "user", content: [{ type: "input_text", text: args.user }] }],
          ...(args.webSearch ? { tools: [{ type: "web_search" }] } : {}),
          reasoning: { effort: config.ai.reasoningEffort },
          text: {
            // JSONフィールドの冗長な文章を抑え、長い旅行でも全日程を書き切らせる。
            verbosity: "low",
            format: { type: "json_schema", name: args.schemaName, strict: true, schema: args.schema },
          },
          max_output_tokens: config.ai.maxOutputTokens,
          store: false,
        }),
        signal: AbortSignal.timeout(remaining),
      });

      const data = await response.json().catch(() => null) as OpenAiResponse | null;
      if (!response.ok) throw classifiedError(response, data, args.userManagedKey);
      const requestId = requestIdOf(response, data);
      if (!data) {
        throw new AiUpstreamError(
          "ai_invalid_response",
          "AIから結果を読み取れませんでした。もう一度お試しください。",
          { retryable: true, action: "retry", requestId },
        );
      }

      const content = extractOutput(data, requestId, args.userManagedKey);
      let value: T;
      try {
        value = JSON.parse(content) as T;
      } catch (error) {
        throw new AiOutputError(`AIの構造化応答を解析できませんでした: ${String(error)}`);
      }
      const meta: OpenAiMeta = {
        requestId,
        model: config.ai.model,
        durationMs: Date.now() - startedAt,
        inputTokens: Number(data.usage?.input_tokens) || 0,
        outputTokens: Number(data.usage?.output_tokens) || 0,
      };
      console.info("[travel-ai]", JSON.stringify({
        schema: args.schemaName,
        request_id: meta.requestId,
        model: meta.model,
        duration_ms: meta.durationMs,
        input_tokens: meta.inputTokens,
        output_tokens: meta.outputTokens,
      }));
      return { value, meta };
    } catch (error) {
      if (error instanceof AiUpstreamError) {
        lastError = error;
        if (error.retryable && attempt < config.ai.maxRetries && Date.now() < deadline) {
          console.warn("[travel-ai] retry", JSON.stringify({
            schema: args.schemaName,
            code: error.code,
            request_id: error.requestId,
            attempt: attempt + 1,
          }));
          await sleep(Math.min(retryDelay(response, attempt), Math.max(0, deadline - Date.now())));
          continue;
        }
        throw error;
      }
      if (error instanceof AiOutputError) throw error;
      lastError = error;
      if (attempt < config.ai.maxRetries && Date.now() < deadline) {
        await sleep(Math.min(retryDelay(response, attempt), Math.max(0, deadline - Date.now())));
        continue;
      }
    }
  }
  const timedOut = lastError instanceof DOMException && ["AbortError", "TimeoutError"].includes(lastError.name);
  throw new AiUpstreamError(
    timedOut ? "ai_timeout" : "ai_network_failed",
    timedOut
      ? "AIの応答が時間内に完了しませんでした。もう一度お試しください。"
      : "AIサービスへ接続できませんでした。時間を置いてお試しください。",
    {
      retryable: true,
      action: timedOut ? "retry" : "retry_later",
      causeDetail: String(lastError || "network error").slice(0, 500),
    },
  );
}

/** 保存前に課金を発生させず、OpenAI側でキーの認証が通ることを確認する。 */
export async function verifyOpenAiApiKey(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.openai.com/v1/models/${encodeURIComponent(config.ai.model)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new AiUpstreamError(
      "ai_key_verification_failed",
      "OpenAIへ接続できずAPIキーを確認できませんでした。時間を置いてもう一度お試しください。",
      { retryable: true, action: "retry_later", causeDetail: String(error).slice(0, 500) },
    );
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return;
  }
  const data = await response.json().catch(() => null) as OpenAiResponse | null;
  throw classifiedError(response, data, true);
}
