import { config } from "./config.js";
import { AiOutputError, AiUpstreamError } from "./ai-errors.js";

const ENDPOINT = "https://api.openai.com/v1/responses";
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

interface OpenAiResponse {
  id?: string;
  status?: string;
  error?: { code?: string; message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: {
    type?: string;
    content?: { type?: string; text?: string; refusal?: string }[];
  }[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
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
  webSearch?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

function retryDelay(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1000 + Math.random() * 250);
  const retryAt = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(retryAt)) return Math.min(10_000, Math.max(0, retryAt - Date.now()) + Math.random() * 250);
  return Math.min(5_000, 300 * (2 ** attempt) + Math.random() * 250);
}

function safeUpstreamDetail(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const error = (value as OpenAiResponse).error;
  return [error?.code, error?.message].filter(Boolean).join(": ").slice(0, 500);
}

function extractOutput(data: OpenAiResponse): string {
  if (data.status === "failed" || data.error) {
    throw new AiUpstreamError(
      "ai_response_failed",
      "AIサービスが行程生成を完了できませんでした。時間を置いてお試しください。",
      { retryable: true, causeDetail: safeUpstreamDetail(data) },
    );
  }
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason || "unknown";
    throw new AiUpstreamError(
      "ai_incomplete",
      "AIの応答が途中で終了しました。もう一度お試しください。",
      { retryable: reason === "max_output_tokens", causeDetail: reason },
    );
  }
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    for (const content of item.content || []) {
      if (content.type === "refusal") {
        throw new AiUpstreamError(
          "ai_refused",
          "この条件ではAIが旅行案を作成できませんでした。希望の表現を変えてお試しください。",
          { causeDetail: String(content.refusal || "refusal").slice(0, 500) },
        );
      }
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  throw new AiUpstreamError("ai_empty_response", "AIから結果が返りませんでした。もう一度お試しください。");
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
          Authorization: `Bearer ${config.ai.apiKey}`,
        },
        body: JSON.stringify({
          model: config.ai.model,
          instructions: args.system,
          input: [{ role: "user", content: [{ type: "input_text", text: args.user }] }],
          ...(args.webSearch ? { tools: [{ type: "web_search" }] } : {}),
          text: {
            format: { type: "json_schema", name: args.schemaName, strict: true, schema: args.schema },
          },
          max_output_tokens: config.ai.maxOutputTokens,
          store: false,
        }),
        signal: AbortSignal.timeout(remaining),
      });

      const data = await response.json().catch(() => null) as OpenAiResponse | null;
      if (!response.ok) {
        const retryable = RETRYABLE_STATUSES.has(response.status);
        const detail = safeUpstreamDetail(data);
        if (retryable && attempt < config.ai.maxRetries && Date.now() < deadline) {
          await sleep(Math.min(retryDelay(response, attempt), Math.max(0, deadline - Date.now())));
          continue;
        }
        throw new AiUpstreamError(
          response.status === 429 ? "ai_rate_limited" : "ai_upstream_failed",
          response.status === 429
            ? "AIが混み合っています。少し待ってからお試しください。"
            : "AIサービスとの通信に失敗しました。時間を置いてお試しください。",
          { retryable, causeDetail: `${response.status}${detail ? ` ${detail}` : ""}` },
        );
      }
      if (!data) throw new AiUpstreamError("ai_invalid_response", "AIから結果を読み取れませんでした。");

      const content = extractOutput(data);
      let value: T;
      try {
        value = JSON.parse(content) as T;
      } catch (error) {
        throw new AiOutputError(`AIの構造化応答を解析できませんでした: ${String(error)}`);
      }
      const meta: OpenAiMeta = {
        requestId: response.headers.get("x-request-id") || data.id || "",
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
        if (error.retryable && attempt < config.ai.maxRetries && Date.now() < deadline) {
          lastError = error;
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
  throw new AiUpstreamError(
    "ai_network_failed",
    "AIサービスへ接続できませんでした。時間を置いてお試しください。",
    { retryable: true, causeDetail: String(lastError || "network error").slice(0, 500) },
  );
}
