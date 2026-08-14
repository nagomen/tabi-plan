// 旅行ダッシュボードの共有ストア API。
//
// Vote とは別プロセス・別データベース。MySQL が localhost バインドのため
// 同じ VPS 上で動かし、nginx から /api/ を proxy_pass して受ける。
//
// エンドポイント（フロントの shared/backend.ts のリモート契約に対応）:
//   GET    /api/health
//   GET    /api/bootstrap          → 関係テーブルの全データ（routes.ts）
//   その他 /api/users|plans|expenses|friendships …（routes.ts）
//   GET    /api/store              → 旧 KV。LEGACY_STORE_TOKEN がある時だけ管理用途で開く
//   PUT    /api/store/<key>        → body {value, version?}
//   DELETE /api/store/<key>
//
// API_TOKEN はアプリ配信元からの基本ゲート。ユーザー権限はサーバー発行の
// X-Travel-Session を検証して判定し、ブラウザ側の userId は信頼しない。

import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";
import { dump, put, remove, VersionConflict } from "./store.js";
import { ping, BadRequest, signUp, logIn } from "./repo.js";
import { route } from "./routes.js";

// ---- レート制限（プロセス内・1分窓） -----------------------------------

const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const slot = hits.get(ip);
  if (!slot || now >= slot.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  slot.count += 1;
  return slot.count > config.rateLimitPerMinute;
}

// 溜まりっぱなしを防ぐ
setInterval(() => {
  const now = Date.now();
  for (const [ip, slot] of hits) if (now >= slot.resetAt) hits.delete(ip);
}, 60_000).unref();

// ---- 補助 ---------------------------------------------------------------

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
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

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
}

function sessionForUser(userId: string): string {
  const payload = b64url(JSON.stringify({ sub: userId, exp: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${signPayload(payload)}`;
}

function userIdFromSession(token: string): string {
  if (!token || !token.includes(".")) return "";
  const [payload, signature] = token.split(".", 2);
  if (!signature || signature.length !== signPayload(payload).length) return "";
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(signPayload(payload)))) return "";
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string; exp?: number };
    if (!parsed.sub || !parsed.exp || parsed.exp < Date.now()) return "";
    return parsed.sub;
  } catch {
    return "";
  }
}

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

function authorizedLegacyStore(req: http.IncomingMessage): boolean {
  if (!config.legacyStoreToken) return false;
  const header = req.headers.authorization || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const custom = req.headers["x-travel-legacy-token"];
  const token = bearer || (typeof custom === "string" ? custom : "");
  if (token.length !== config.legacyStoreToken.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i += 1) diff |= token.charCodeAt(i) ^ config.legacyStoreToken.charCodeAt(i);
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

  if (path === "/api/health") {
    try {
      await ping();
      send(res, 200, { ok: true }, cors);
    } catch (error) {
      send(res, 503, { ok: false, error: String(error) }, cors);
    }
    return;
  }

  // ブラウザから来た（Origin 付き）のに許可外なら、ここで落とす
  if (origin && !Object.keys(cors).length) {
    send(res, 403, { error: "origin not allowed" });
    return;
  }

  if (rateLimited(clientIp(req))) {
    send(res, 429, { error: "too many requests" }, cors);
    return;
  }

  if (!authorized(req)) {
    send(res, 401, { error: "unauthorized" }, cors);
    return;
  }

  try {
    // 関係テーブル（新）。該当しなければ下の KV（旧）へ落ちる。
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readJsonBody(req);
    if (path === "/api/auth/signup" && req.method === "POST") {
      const result = await signUp({
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
        displayName: typeof body.display_name === "string" ? body.display_name : "",
      });
      send(res, 200, { ...result, session: sessionForUser(result.user.id) }, cors);
      return;
    }
    if (path === "/api/auth/login" && req.method === "POST") {
      const result = await logIn({
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      send(res, 200, { ...result, session: sessionForUser(result.user.id) }, cors);
      return;
    }
    const actorUserId = typeof req.headers["x-travel-session"] === "string"
      ? userIdFromSession(req.headers["x-travel-session"])
      : "";
    const handled = await route(req.method || "GET", path, body, actorUserId);
    if (handled) {
      send(res, handled.status, handled.body, cors);
      return;
    }

    if (path === "/api/store" && req.method === "GET") {
      if (!authorizedLegacyStore(req)) {
        send(res, config.legacyStoreToken ? 401 : 410, { error: "legacy store is disabled" }, cors);
        return;
      }
      send(res, 200, await dump(), cors);
      return;
    }

    const match = /^\/api\/store\/(.+)$/.exec(path);
    if (match) {
      if (!authorizedLegacyStore(req)) {
        send(res, config.legacyStoreToken ? 401 : 410, { error: "legacy store is disabled" }, cors);
        return;
      }
      const key = decodeURIComponent(match[1]);
      if (!key || key.length > 191) {
        send(res, 400, { error: "invalid key" }, cors);
        return;
      }

      if (req.method === "PUT") {
        const parsed = body as { value?: unknown; version?: number };
        if (!("value" in parsed)) {
          send(res, 400, { error: "value is required" }, cors);
          return;
        }
        try {
          const saved = await put(key, parsed.value, parsed.version);
          send(res, 200, { ok: true, version: saved.version }, cors);
        } catch (error) {
          if (error instanceof VersionConflict) {
            // 手元が古い。現在値を返すので、呼び出し側でマージして再送する。
            send(res, 409, { error: "version conflict", current: error.current.value, version: error.current.version }, cors);
            return;
          }
          throw error;
        }
        return;
      }

      if (req.method === "DELETE") {
        await remove(key);
        send(res, 200, { ok: true }, cors);
        return;
      }
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
    server.close(() => process.exit(0));
  });
}
