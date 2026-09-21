// 設定は環境変数のみから読む（.env はデプロイ時にサーバーへ置く）。
// このファイルはサーバー側専用。フロントのバンドルには絶対に含めないこと。

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`環境変数 ${name} が設定されていません`);
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function list(name: string): string[] {
  return optional(name, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function integer(name: string, fallback: string, min: number, max: number): number {
  const raw = optional(name, fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`環境変数 ${name} は ${min}〜${max} の整数で指定してください`);
  }
  return value;
}

function oneOf<const T extends readonly string[]>(name: string, fallback: T[number], values: T): T[number] {
  const value = optional(name, fallback);
  if (!values.includes(value as T[number])) {
    throw new Error(`環境変数 ${name} は ${values.join(" / ")} のいずれかで指定してください`);
  }
  return value as T[number];
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET は32文字以上のランダム値にしてください");
}
const aiCredentialEncryptionKey = optional("AI_CREDENTIAL_ENCRYPTION_KEY", sessionSecret);
if (aiCredentialEncryptionKey.length < 32) {
  throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY は32文字以上のランダム値にしてください");
}
// ローテーション中だけ設定する旧鍵。復号にだけ使い、保存は常に現行鍵で行う。
const aiCredentialEncryptionKeyPrevious = optional("AI_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS", "");
if (aiCredentialEncryptionKeyPrevious && aiCredentialEncryptionKeyPrevious.length < 32) {
  throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY_PREVIOUS は32文字以上のランダム値にしてください");
}

export const config = {
  port: integer("PORT", "8001", 1, 65_535),
  host: optional("HOST", "127.0.0.1"),

  db: {
    host: optional("DB_HOST", "127.0.0.1"),
    port: integer("DB_PORT", "3306", 1, 65_535),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: optional("DB_NAME", "TravelPlan"),
  },

  /** ログインセッション署名用。ブラウザへ公開しない。 */
  sessionSecret,

  /** ログインセッションの保持日数。漏えい時の影響を抑えるため既定は7日。 */
  sessionTtlDays: integer("SESSION_TTL_DAYS", "7", 1, 365),

  /**
   * この時刻（Unix ms）より前に発行されたセッションを全失効する。
   * インシデント時や秘密鍵ローテーション時の緊急遮断に使う。
   */
  sessionEpochMs: integer("SESSION_EPOCH_MS", "0", 0, Number.MAX_SAFE_INTEGER),

  /** CORS 許可オリジン。GitHub Pages のオリジンを入れる。 */
  allowedOrigins: list("ALLOWED_ORIGINS"),

  /** 1リクエストあたりの本文上限（バイト）。 */
  maxBodyBytes: integer("MAX_BODY_BYTES", String(2 * 1024 * 1024), 1024, 50 * 1024 * 1024),

  /** 1オリジンIPあたりの毎分リクエスト上限。 */
  rateLimitPerMinute: integer("RATE_LIMIT_PER_MINUTE", "240", 1, 100_000),

  /** サインアップ・ログインにだけ適用する、より厳しい毎分上限。 */
  authRateLimitPerMinute: integer("AUTH_RATE_LIMIT_PER_MINUTE", "10", 1, 10_000),

  /** Cloudflareが直接の信頼済みプロキシである環境だけ true にする。 */
  trustCloudflareConnectingIp: optional("TRUST_CLOUDFLARE_CONNECTING_IP", "false") === "true",

  /**
   * LINE ログイン。チャンネルシークレットはサーバーにだけ置く。
   * 未設定なら LINE ログインの導線ごと無効になる。
   */
  line: {
    channelId: optional("LINE_CHANNEL_ID", ""),
    channelSecret: optional("LINE_CHANNEL_SECRET", ""),
    /** LINE Developers に登録したコールバック URL と完全一致させる。 */
    callbackUrl: optional(
      "LINE_CALLBACK_URL",
      "https://travel-api.vote-jt.com/api/auth/line/callback",
    ),
  },

  /**
   * 失敗を知らせるために戻すログイン画面。
   * 許可オリジンの直下にアプリが無い（GitHub Pages のサブパス）ので、
   * オリジンだけからは組み立てられない。未設定なら戻り先から推測する。
   */
  loginUrl: optional("LOGIN_URL", ""),

  /**
   * ChatGPT からこの旅行へ接続する MCP/OAuth。認可画面だけ GitHub Pages に置き、
   * トークン発行とデータ更新は常にこの API で行う。
   */
  mcp: {
    issuerUrl: optional("MCP_ISSUER_URL", "https://travel-api.vote-jt.com").replace(/\/+$/, ""),
    resourceUrl: optional("MCP_RESOURCE_URL", "https://travel-api.vote-jt.com/mcp"),
    approvalUrl: optional(
      "MCP_APPROVAL_URL",
      "https://nagomen.github.io/tabi-plan/mcp-authorize.html",
    ),
    accessTokenTtlSeconds: integer("MCP_ACCESS_TOKEN_TTL_SECONDS", "3600", 300, 86_400),
    refreshTokenTtlDays: integer("MCP_REFRESH_TOKEN_TTL_DAYS", "30", 1, 365),
  },

  /**
   * 旅程の下書きを作る AI。キーはサーバーにだけ置く
   * （静的サイトに出すと誰でも使えてしまう）。未設定なら機能ごと無効。
   */
  ai: {
    apiKey: optional("OPENAI_KEY", ""),
    /**
     * 利用者が登録したAPIキーの保存用マスターキー。
     * 既存環境との互換のため未設定時はSESSION_SECRETを使うが、本番では
     * セッション失効と独立してローテーションできる専用値を推奨する。
     */
    credentialEncryptionKey: aiCredentialEncryptionKey,
    /**
     * ローテーション中の旧マスターキー。現行鍵で復号できなかった行だけこちらを試し、
     * 成功した行はその場で現行鍵へ再暗号化する。移行が終わったら空に戻す。
     */
    credentialEncryptionKeyPrevious: aiCredentialEncryptionKeyPrevious,
    model: optional("OPENAI_MODEL", "gpt-5.4-mini"),
    timeoutMs: integer("OPENAI_TIMEOUT_MS", "80000", 1000, 300_000),
    // 長い行程のJSONへ出力枠を回す。推論量は機械的な構造化タスク向けに抑える。
    reasoningEffort: oneOf("OPENAI_REASONING_EFFORT", "none", ["none", "low", "medium", "high", "xhigh"] as const),
    maxOutputTokens: integer("OPENAI_MAX_OUTPUT_TOKENS", "30000", 512, 100_000),
    maxRetries: integer("OPENAI_MAX_RETRIES", "2", 0, 5),
    webSearchEnabled: optional("OPENAI_WEB_SEARCH_ENABLED", "true") === "true",
    dailyRequestsPerUser: Math.min(integer("AI_DAILY_REQUESTS_PER_USER", "3", 1, 10_000), 3),
    dailyTokensPerUser: integer("AI_DAILY_TOKENS_PER_USER", "400000", 1_000, 100_000_000),
    cooldownSeconds: integer("AI_COOLDOWN_SECONDS", "20", 0, 3600),
  },

  /** 移動候補検索。キー未設定のプロバイダは自動で無効。 */
  transport: {
    googleRoutesApiKey: optional("GOOGLE_ROUTES_API_KEY", ""),
    amadeusClientId: optional("AMADEUS_CLIENT_ID", ""),
    amadeusClientSecret: optional("AMADEUS_CLIENT_SECRET", ""),
    amadeusBaseUrl: optional("AMADEUS_BASE_URL", "https://test.api.amadeus.com").replace(/\/+$/, ""),
  },
} as const;
