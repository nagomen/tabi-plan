/** 利用者が直せるAI入力エラー。HTTP 400へ変換する。 */
export class AiInputError extends Error {
  readonly code = "invalid_ai_input";
}

/** サーバー設定不足。秘密や上流レスポンスは利用者へ返さない。 */
export class AiUnavailableError extends Error {
  readonly code = "ai_unavailable";
}

/** OpenAI APIの一時障害・拒否・不完全応答。詳細はサーバーログだけに残す。 */
export class AiUpstreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly causeDetail: string;

  constructor(code: string, message: string, options?: { retryable?: boolean; causeDetail?: string }) {
    super(message);
    this.code = code;
    this.retryable = Boolean(options?.retryable);
    this.causeDetail = options?.causeDetail || "";
  }
}

/** JSONの形は正しくても旅行計画として成立しないAI応答。 */
export class AiOutputError extends Error {
  readonly code = "invalid_ai_output";
}
