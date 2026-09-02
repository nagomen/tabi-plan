/** 利用者が直せるAI入力エラー。HTTP 400へ変換する。 */
export class AiInputError extends Error {
  readonly code = "invalid_ai_input";
  readonly action = "revise_input" as const;
}

/** サーバー設定不足。秘密や上流レスポンスは利用者へ返さない。 */
export class AiUnavailableError extends Error {
  readonly code = "ai_unavailable";
  readonly action = "contact_support" as const;
}

export type AiRecoveryAction =
  | "retry"
  | "retry_later"
  | "revise_input"
  | "restart_consultation"
  | "contact_support";

/** OpenAI APIの一時障害・拒否・不完全応答。詳細はサーバーログだけに残す。 */
export class AiUpstreamError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfter: number;
  readonly action: AiRecoveryAction;
  readonly requestId: string;
  readonly causeDetail: string;

  constructor(code: string, message: string, options?: {
    retryable?: boolean;
    retryAfter?: number;
    action?: AiRecoveryAction;
    requestId?: string;
    causeDetail?: string;
  }) {
    super(message);
    this.code = code;
    this.retryable = Boolean(options?.retryable);
    this.retryAfter = Math.max(0, Math.ceil(Number(options?.retryAfter) || 0));
    this.action = options?.action || (this.retryable ? "retry_later" : "contact_support");
    this.requestId = options?.requestId || "";
    this.causeDetail = options?.causeDetail || "";
  }
}

/** JSONの形は正しくても旅行計画として成立しないAI応答。 */
export class AiOutputError extends Error {
  readonly code = "invalid_ai_output";
  readonly action = "retry" as const;
}
