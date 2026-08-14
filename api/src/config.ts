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

const apiToken = required("API_TOKEN");
const sessionSecret = required("SESSION_SECRET");
if (sessionSecret === apiToken) {
  throw new Error("SESSION_SECRET は公開 API_TOKEN とは別の十分に長い秘密値にしてください");
}

export const config = {
  port: Number(optional("PORT", "8001")),
  host: optional("HOST", "127.0.0.1"),

  db: {
    host: optional("DB_HOST", "127.0.0.1"),
    port: Number(optional("DB_PORT", "3306")),
    user: required("DB_USER"),
    password: required("DB_PASSWORD"),
    database: optional("DB_NAME", "TravelPlan"),
  },

  /** 静的サイトから呼ぶので、この値はブラウザに見える。総当たり避け程度の意味しかない。 */
  apiToken,

  /** ログインセッション署名用。API_TOKEN は静的サイトに露出するため絶対に流用しない。 */
  sessionSecret,

  /** 旧 KV ストアの管理用トークン。未設定なら /api/store は無効。 */
  legacyStoreToken: optional("LEGACY_STORE_TOKEN", ""),

  /** CORS 許可オリジン。GitHub Pages のオリジンを入れる。 */
  allowedOrigins: list("ALLOWED_ORIGINS"),

  /** 1リクエストあたりの本文上限（バイト）。 */
  maxBodyBytes: Number(optional("MAX_BODY_BYTES", String(2 * 1024 * 1024))),

  /** 1オリジンIPあたりの毎分リクエスト上限。 */
  rateLimitPerMinute: Number(optional("RATE_LIMIT_PER_MINUTE", "240")),
} as const;
