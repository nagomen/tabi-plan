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
import { authorizeUrl, handleLineCallback, lineLoginEnabled, loginErrorUrl, peekReturnTo } from "./line-auth.js";
import {
  signUp, logIn, createSession, resolveSession, revokeSession,
  revokeOtherSessions, changePassword, addCredentials,
} from "./auth-repo.js";
import { BadRequest, VersionConflict as PlanVersionConflict } from "./errors.js";
import { route } from "./routes.js";
import { closeDatabase, pingDatabase } from "./db.js";
import { rateLimited, sweepExpired, type RateBucket } from "./rate-limit.js";
import { clientIp } from "./client-ip.js";

// ---- レート制限（プロセス内・1分窓） -----------------------------------

const hits = new Map<string, RateBucket>();
const authHits = new Map<string, RateBucket>();

// 溜まりっぱなしを防ぐ
setInterval(() => {
  sweepExpired(hits);
  sweepExpired(authHits);
}, 60_000).unref();

// ---- 補助 ---------------------------------------------------------------

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

function redirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
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

  const ip = clientIp(req, config.trustCloudflareConnectingIp);
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

  // LINE ログインはブラウザの画面遷移で来るので、API トークンを付けられない。
  // ここだけトークン判定の前に置き、代わりに認証用の厳しい回数制限を当てる。
  if (path === "/api/auth/line/start" || path === "/api/auth/line/callback") {
    if (!lineLoginEnabled()) {
      send(res, 503, { error: "LINE ログインは設定されていません" }, cors);
      return;
    }
    if (rateLimited(authHits, ip, config.authRateLimitPerMinute)) {
      send(res, 429, { error: "too many authentication attempts" }, cors);
      return;
    }
    const query = new URL(req.url || "/", "http://localhost").searchParams;
    if (path === "/api/auth/line/start") {
      // ここは画面遷移で来るため、クエリはアクセスログに残る。
      // よってセッショントークンは受け取らない（紐付けは
      // POST /api/auth/line/authorize-url 側で扱う）。nonce は秘密ではない。
      //
      // link= を付けてくるのは、紐付けを URL で渡していた古い画面。
      // そのまま進めると紐付けではなく新規ログインになり、別アカウントが
      // できてしまうので、読み込み直しを促して止める。
      if (query.get("link")) {
        redirect(res, loginErrorUrl(
          query.get("return_to") || "",
          "画面を読み込み直してから、もう一度お試しください",
        ));
        return;
      }
      redirect(res, authorizeUrl(query.get("return_to") || "", "", query.get("nonce") || ""));
      return;
    }
    try {
      const result = await handleLineCallback({
        code: query.get("code") || "",
        state: query.get("state") || "",
      });
      const session = await sessionForUser(result.userId);
      // セッションは #fragment で渡す。サーバーへ送られないのでログに残らない。
      // nonce も返し、手続きを始めた本人のブラウザだけが受け取れるようにする。
      const fragment = `line_session=${encodeURIComponent(session)}`
        + (result.nonce ? `&line_nonce=${encodeURIComponent(result.nonce)}` : "");
      redirect(res, `${result.returnTo}#${fragment}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "LINE ログインに失敗しました";
      redirect(res, loginErrorUrl(peekReturnTo(query.get("state") || ""), message));
    }
    return;
  }

  if (!authorized(req)) {
    send(res, 401, { error: "unauthorized" }, cors);
    return;
  }

  const authPaths = [
    "/api/auth/signup", "/api/auth/login",
    "/api/auth/password", "/api/auth/credentials",
  ];
  if (authPaths.includes(path) && rateLimited(authHits, ip, config.authRateLimitPerMinute)) {
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
    // LINE の認可 URL を作って返すだけ。セッションはヘッダで受け取るので、
    // 紐付けのときもトークンが URL（＝アクセスログ）へ出ない。
    if (path === "/api/auth/line/authorize-url" && req.method === "POST") {
      if (!lineLoginEnabled()) {
        send(res, 503, { error: "LINE ログインは設定されていません" }, cors);
        return;
      }
      const linkTo = await resolveSession(sessionToken);
      const url = authorizeUrl(
        typeof body.return_to === "string" ? body.return_to : "",
        linkTo,
        typeof body.nonce === "string" ? body.nonce : "",
      );
      send(res, 200, { url }, cors);
      return;
    }
    const actorUserId = await resolveSession(sessionToken);
    // パスワードの変更・追加は、本人のセッションが要る。
    // 401 を返すのは「ログインし直せば直る」と画面に伝えるため。
    if (path === "/api/auth/password" && req.method === "POST") {
      if (!actorUserId) {
        send(res, 401, { error: "session_required" }, cors);
        return;
      }
      await changePassword({
        userId: actorUserId,
        currentPassword: typeof body.current_password === "string" ? body.current_password : "",
        newPassword: typeof body.new_password === "string" ? body.new_password : "",
      });
      // 変えた意味を持たせるため、他の端末のセッションは切る。
      const revoked = await revokeOtherSessions(actorUserId, sessionToken);
      send(res, 200, { ok: true, revoked }, cors);
      return;
    }
    if (path === "/api/auth/credentials" && req.method === "POST") {
      if (!actorUserId) {
        send(res, 401, { error: "session_required" }, cors);
        return;
      }
      const added = await addCredentials({
        userId: actorUserId,
        email: typeof body.email === "string" ? body.email : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      send(res, 200, { ok: true, ...added }, cors);
      return;
    }
    if (path === "/api/auth/sessions/revoke-others" && req.method === "POST") {
      if (!actorUserId) {
        send(res, 401, { error: "session_required" }, cors);
        return;
      }
      send(res, 200, { ok: true, revoked: await revokeOtherSessions(actorUserId, sessionToken) }, cors);
      return;
    }
    // 手元のトークンが無効なのに書き込みへ来たら、権限不足ではなく期限切れ。
    // 403 だと画面に「権限がありません」と出て、ログインし直す導線が出ない。
    if (sessionToken && !actorUserId && req.method !== "GET") {
      send(res, 401, { error: "session_required" }, cors);
      return;
    }
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
