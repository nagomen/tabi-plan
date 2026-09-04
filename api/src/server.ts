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
// 公開計画は匿名で読める。非公開データと書き込み権限はサーバー発行の
// X-Travel-Session を検証して判定し、ブラウザ側の userId は信頼しない。

import http from "node:http";
import crypto from "node:crypto";
import { config } from "./config.js";
import {
  authorizeUrl, handleLineCallback, LineAuthError, lineLoginEnabled, loginErrorUrl, peekReturnTo,
} from "./line-auth.js";
import {
  signUp, logIn, createSession, resolveSession, revokeSession,
  revokeOtherSessions, changePassword, addCredentials, recoverPassword, rotateRecoveryCode,
} from "./auth-repo.js";
import { describeError } from "./errors.js";
import { route } from "./routes.js";
import { closeDatabase, pingDatabase } from "./db.js";
import { rateLimitCheck, sweepExpired, type RateBucket } from "./rate-limit.js";
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
    // 問い合わせ番号と再試行待ち時間は、別オリジンのブラウザにも読ませる。
    "Access-Control-Expose-Headers": "X-Request-Id,Retry-After",
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
  // 二重送信は writeHead が throw し、async ハンドラ内だと未処理拒否で
  // プロセスごと落ちる。送信済みならログに残して黙って打ち切る。
  if (res.headersSent) {
    console.error("[travel-api] response already sent", JSON.stringify({ status }));
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extra,
  });
  res.end(json);
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
  // 問い合わせ番号。全レスポンスに付け、エラーログと突き合わせられるようにする。
  const requestId = crypto.randomBytes(8).toString("hex");
  res.setHeader("X-Request-Id", requestId);

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
  const globalWait = rateLimitCheck(hits, ip, config.rateLimitPerMinute);
  if (globalWait > 0) {
    send(res, 429, {
      error: "too many requests",
      message: "アクセスが集中しています。少し待ってからもう一度お試しください。",
      retryable: true,
      retry_after: globalWait,
      action: "retry_later",
    }, { ...cors, "Retry-After": String(globalWait) });
    return;
  }

  if (path === "/api/health") {
    try {
      await pingDatabase();
      send(res, 200, { ok: true }, cors);
    } catch (error) {
      // 認証前に匿名で叩ける口なので、接続文字列などの内部情報は返さない。
      console.error("[travel-api] health check failed", JSON.stringify({ request_id: requestId }), error);
      send(res, 503, { ok: false, error: "database unavailable" }, cors);
    }
    return;
  }

  // LINE ログインはブラウザの画面遷移で来るので、API トークンを付けられない。
  // ここだけトークン判定の前に置き、代わりに認証用の厳しい回数制限を当てる。
  if (path === "/api/auth/line/start" || path === "/api/auth/line/callback") {
    const query = new URL(req.url || "/", "http://localhost").searchParams;
    if (!lineLoginEnabled()) {
      send(res, 503, { error: "LINE ログインは設定されていません" }, cors);
      return;
    }
    // 画面遷移で来る口なので、拒否も JSON ではなくログイン画面へ戻して伝える。
    if (rateLimitCheck(authHits, ip, config.authRateLimitPerMinute) > 0) {
      redirect(res, loginErrorUrl(
        query.get("return_to") || peekReturnTo(query.get("state") || ""),
        "ログインの試行回数が上限に達しました。しばらく待ってからお試しください",
      ));
      return;
    }
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
      // 画面に出すのは LineAuthError の安全な文言だけ。DB・fetch の生エラーは
      // URL（＝アクセスログや画面）へ出さず、問い合わせ番号付きでログに残す。
      console.error("[travel-api] line login failed", JSON.stringify({
        request_id: requestId,
        detail: error instanceof LineAuthError ? error.causeDetail : "",
      }), error instanceof LineAuthError ? error.message : error);
      const message = error instanceof LineAuthError
        ? error.message
        : "LINEログインを完了できませんでした。時間をおいてもう一度お試しください";
      redirect(res, loginErrorUrl(peekReturnTo(query.get("state") || ""), message));
    }
    return;
  }

  const authPaths = [
    "/api/auth/signup", "/api/auth/login", "/api/auth/recover",
    "/api/auth/password", "/api/auth/credentials",
    "/api/auth/recovery-code",
    // 招待トークンは総当たりの対象になるため、認証と同じ厳しい制限を当てる。
    "/api/invites/accept", "/api/invites/inspect",
  ];
  if (authPaths.includes(path)) {
    const authWait = rateLimitCheck(authHits, ip, config.authRateLimitPerMinute);
    if (authWait > 0) {
      send(res, 429, {
        error: "too many authentication attempts",
        message: "試行回数が上限に達しました。しばらく待ってからもう一度お試しください。",
        retryable: true,
        retry_after: authWait,
        action: "retry_later",
      }, { ...cors, "Retry-After": String(authWait) });
      return;
    }
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
    if (path === "/api/auth/recover" && req.method === "POST") {
      const result = await recoverPassword({
        email: typeof body.email === "string" ? body.email : "",
        recoveryCode: typeof body.recovery_code === "string" ? body.recovery_code : "",
        newPassword: typeof body.new_password === "string" ? body.new_password : "",
      });
      send(res, 200, { ok: true, ...result }, cors);
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
      const changed = await changePassword({
        userId: actorUserId,
        currentPassword: typeof body.current_password === "string" ? body.current_password : "",
        newPassword: typeof body.new_password === "string" ? body.new_password : "",
        keepToken: sessionToken,
      });
      send(res, 200, { ok: true, ...changed }, cors);
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
    if (path === "/api/auth/recovery-code" && req.method === "POST") {
      if (!actorUserId) {
        send(res, 401, { error: "session_required" }, cors);
        return;
      }
      send(res, 200, { ok: true, ...await rotateRecoveryCode(actorUserId) }, cors);
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
    const publicWrite = path === "/api/invites/inspect" && req.method === "POST";
    if (sessionToken && !actorUserId && req.method !== "GET" && !publicWrite) {
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
    // 分類はすべて errors.ts に集約。内部情報は本文へ出さず、ログにだけ残す。
    const { status, body } = describeError(error, requestId);
    if (status >= 500 || body.error === "db_unavailable" || body.error === "server_busy") {
      console.error("[travel-api] request failed", JSON.stringify({
        request_id: requestId,
        method: req.method || "",
        path,
        status,
        code: body.error,
      }), error);
    }
    const retryAfter: Record<string, string> = body.retry_after
      ? { "Retry-After": String(body.retry_after) }
      : {};
    send(res, status, body, { ...cors, ...retryAfter });
  }
});

// listen 失敗（ポート使用中など）を素のスタックではなく一行で説明して終了する。
server.on("error", (error: NodeJS.ErrnoException) => {
  console.error(`[travel-api] server error: ${error.code || ""} ${error.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`[travel-api] listening on http://${config.host}:${config.port}`);
  console.log(`[travel-api] db=${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log(`[travel-api] allowed origins: ${config.allowedOrigins.join(", ") || "(なし)"}`);
  if (!config.allowedOrigins.length) {
    console.warn("[travel-api] ALLOWED_ORIGINS が空のため、ブラウザからのリクエストはすべて403になります");
  }
  // 起動直後にDBへ到達できるか確かめる。lazyなプールだと初回リクエストまで
  // 設定ミスに気付けないため、ここで一度だけ検査してログに残す（起動は止めない）。
  pingDatabase().catch((error) => {
    console.error("[travel-api] 起動時のDB接続確認に失敗しました。設定を確認してください", error);
  });
});

// ---- プロセスの安全網 -----------------------------------------------------
// 想定外の例外は握りつぶさずログへ残す。uncaughtException は状態が信用できない
// ため終了し、systemd（Restart=always）に再起動させる。
process.on("unhandledRejection", (reason) => {
  console.error("[travel-api] unhandled rejection", reason);
});
process.on("uncaughtException", (error) => {
  console.error("[travel-api] uncaught exception", error);
  shutdown(1);
});

let shuttingDown = false;
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    void closeDatabase().finally(() => process.exit(exitCode));
  });
  // keep-alive の遊休接続は自然には閉じない。先に切って close を進める。
  server.closeIdleConnections();
  // 処理中のリクエストが残っても、systemd の SIGKILL を待たず自分で締める。
  setTimeout(() => {
    server.closeAllConnections();
    void closeDatabase().finally(() => process.exit(exitCode));
  }, 10_000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdown(0));
}
