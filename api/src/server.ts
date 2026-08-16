// 旅行ダッシュボードの共有ストア API。
//
// Vote とは別プロセス・別データベース。MySQL が localhost バインドのため
// 同じ VPS 上で動かし、nginx から /api/ を proxy_pass して受ける。
//
// エンドポイント（フロントの shared/backend.ts のリモート契約に対応）:
//   GET    /api/health
//   GET    /api/bootstrap          → 関係テーブルの全データ（routes.ts）
//   その他 /api/users|plans|expenses|friendships …（routes.ts）
//
// API_TOKEN はアプリ配信元からの基本ゲート。ユーザー権限はサーバー発行の
// X-Travel-Session を検証して判定し、ブラウザ側の userId は信頼しない。

import http from "node:http";
import { config } from "./config.js";
import { signUp, logIn, createSession, resolveSession, revokeSession } from "./auth-repo.js";
import { BadRequest, VersionConflict as PlanVersionConflict } from "./errors.js";
import { route } from "./routes.js";
import { closeDatabase, pingDatabase } from "./db.js";

// ---- レート制限（プロセス内・1分窓） -----------------------------------

const hits = new Map<string, { count: number; resetAt: number }>();
const authHits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(
  buckets: Map<string, { count: number; resetAt: number }>,
  key: string,
  limit: number,
): boolean {
  const now = Date.now();
  const slot = buckets.get(key);
  if (!slot || now >= slot.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  slot.count += 1;
  return slot.count > limit;
}

// 溜まりっぱなしを防ぐ
setInterval(() => {
  const now = Date.now();
  for (const [ip, slot] of hits) if (now >= slot.resetAt) hits.delete(ip);
  for (const [ip, slot] of authHits) if (now >= slot.resetAt) authHits.delete(ip);
}, 60_000).unref();

// ---- 補助 ---------------------------------------------------------------

function clientIp(req: http.IncomingMessage): string {
  const cloudflare = req.headers["cf-connecting-ip"];
  if (config.trustCloudflareConnectingIp && typeof cloudflare === "string" && cloudflare) {
    return cloudflare.trim();
  }
  const forwarded = req.headers["x-forwarded-for"];
  // API は loopback bind + nginx proxy 前提。末尾が nginx が観測した接続元で、
  // クライアントが先頭へ注入した偽 X-Forwarded-For を信用しない。
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",").at(-1)?.trim() || "unknown";
  return req.socket.remoteAddress || "unknown";
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = origin && config.allowedOrigins.includes(origin);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Travel-Session",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * Math.max(1, config.sessionTtlDays);

const sessionForUser = (userId: string): Promise<string> => createSession(userId, SESSION_TTL_MS);

function send(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(json);
}

function authorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const custom = req.headers["x-travel-token"];
  const token = bearer || (typeof custom === "string" ? custom : "");
  if (token.length !== config.apiToken.length) return false;
  // 定数時間比較
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ config.apiToken.charCodeAt(i);
  return diff === 0;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > config.maxBodyBytes) {
        // 読み捨てつつ 413 を返せるよう、ソケットは切らずに以降を無視する
        aborted = true;
        req.resume();
        reject(new Error("PAYLOAD_TOO_LARGE"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    throw new Error("INVALID_JSON");
  }
}

// ---- ルーティング -------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const cors = corsHeaders(origin);
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "OPTIONS") {
    res.writeHead(Object.keys(cors).length ? 204 : 403, cors);
    res.end();
    return;
  }

  // ブラウザから来た（Origin 付き）のに許可外なら、ここで落とす
  if (origin && !Object.keys(cors).length) {
    send(res, 403, { error: "origin not allowed" });
    return;
  }

  const ip = clientIp(req);
  if (rateLimited(hits, ip, config.rateLimitPerMinute)) {
    send(res, 429, { error: "too many requests" }, cors);
    return;
  }

  if (path === "/api/health") {
    try {
      await pingDatabase();
      send(res, 200, { ok: true }, cors);
    } catch (error) {
      send(res, 503, { ok: false, error: String(error) }, cors);
    }
    return;
  }

  if (!authorized(req)) {
    send(res, 401, { error: "unauthorized" }, cors);
    return;
  }

  if ((path === "/api/auth/signup" || path === "/api/auth/login") &&
      rateLimited(authHits, ip, config.authRateLimitPerMinute)) {
    send(res, 429, { error: "too many authentication attempts" }, cors);
    return;
  }

  try {
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJsonBody(req);
    if (path === "/api/auth/signup" && req.method === "POST") {
      const result = await signUp({
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
        displayName: typeof body.display_name === "string" ? body.display_name : "",
      });
      send(res, 200, { ...result, session: await sessionForUser(result.user.id) }, cors);
      return;
    }
    if (path === "/api/auth/login" && req.method === "POST") {
      const result = await logIn({
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      send(res, 200, { ...result, session: await sessionForUser(result.user.id) }, cors);
      return;
    }
    const sessionToken = typeof req.headers["x-travel-session"] === "string"
      ? req.headers["x-travel-session"]
      : "";
    if (path === "/api/auth/logout" && req.method === "POST") {
      await revokeSession(sessionToken);
      send(res, 200, { ok: true }, cors);
      return;
    }
    const actorUserId = await resolveSession(sessionToken);
    const handled = await route(req.method || "GET", path, body, actorUserId);
    if (handled) {
      send(res, handled.status, handled.body, cors);
      return;
    }

    send(res, 404, { error: "not found" }, cors);
  } catch (error) {
    if ((error as Error).message === "PAYLOAD_TOO_LARGE") {
      send(res, 413, { error: "payload too large" }, cors);
      return;
    }
    if ((error as Error).message === "INVALID_JSON" || error instanceof BadRequest) {
      send(res, 400, { error: (error as Error).message }, cors);
      return;
    }
    if (error instanceof PlanVersionConflict) {
      send(res, 409, { error: error.message }, cors);
      return;
    }
    // 外部キー違反などは呼び出し側の誤りとして 409 を返す
    const code = (error as { code?: string }).code || "";
    if (code.startsWith("ER_NO_REFERENCED_ROW") || code === "ER_DUP_ENTRY" || code === "ER_CHECK_CONSTRAINT_VIOLATED") {
      send(res, 409, { error: code }, cors);
      return;
    }
    console.error("[travel-api]", error);
    send(res, 500, { error: "internal error" }, cors);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[travel-api] listening on http://${config.host}:${config.port}`);
  console.log(`[travel-api] db=${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`[travel-api] allowed origins: ${config.allowedOrigins.join(", ") || "(なし)"}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
  });
}
