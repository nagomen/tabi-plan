// LINE ログイン（LINE Login v2.1 / OAuth 2.0）。
//
// チャンネルシークレットはサーバーにだけ置く。ブラウザは
//   GET /api/auth/line/start    → LINE の認可画面へ 302
//   GET /api/auth/line/callback → ここでコードを交換し、セッションを発行
// の2つだけを踏む。
//
// state は DB に置かず、SESSION_SECRET で署名した値にする（サーバーを
// 増やしても共有不要）。戻り先は許可オリジンだけに限る（オープン
// リダイレクト対策）。発行したセッションは URL の #fragment で渡す。
// fragment はサーバーへ送られないので、アクセスログに残らない。

import crypto from "node:crypto";
import { config } from "./config.js";
import { all, pool } from "./db.js";
import { newId } from "./ids.js";

const AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
const TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";
const VERIFY_URL = "https://api.line.me/oauth2/v2.1/verify";

/** state の有効時間。認可画面での操作に十分で、使い回されない長さ。 */
const STATE_TTL_MS = 10 * 60 * 1000;

export function lineLoginEnabled(): boolean {
  return Boolean(config.line.channelId && config.line.channelSecret);
}

function sign(value: string): string {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

function makeState(returnTo: string, linkTo: string): string {
  const payload = Buffer.from(JSON.stringify({
    r: returnTo,
    // 紐付け先は利用者 id で持つ。セッショントークンを LINE へ渡さないため、
    // start の時点でサーバーが解決しておく。
    l: linkTo || "",
    n: crypto.randomBytes(8).toString("base64url"),
    e: Date.now() + STATE_TTL_MS,
  })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readState(state: string): { returnTo: string; linkTo: string } | null {
  const [payload, mac] = String(state || "").split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      r?: string; l?: string; e?: number;
    };
    if (!parsed.e || parsed.e < Date.now()) return null;
    return { returnTo: String(parsed.r || ""), linkTo: String(parsed.l || "") };
  } catch {
    return null;
  }
}

/**
 * 戻り先の URL を許可オリジンだけに限る。
 * 許可外・未指定なら最初の許可オリジンへ戻す。
 */
export function safeReturnTo(raw: string): string {
  const fallback = config.allowedOrigins[0] || "";
  try {
    const url = new URL(raw);
    if (config.allowedOrigins.includes(url.origin)) {
      url.hash = "";
      return url.toString();
    }
  } catch {
    /* URL として読めない指定は捨てる */
  }
  return fallback;
}

export function authorizeUrl(returnTo: string, linkTo = ""): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.line.channelId,
    redirect_uri: config.line.callbackUrl,
    state: makeState(safeReturnTo(returnTo), linkTo),
    // profile: 表示名とアイコン / openid: 本人確認用の id_token
    scope: "profile openid",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface LineProfile {
  subject: string;
  displayName: string;
  pictureUrl: string;
}

async function exchangeCode(code: string): Promise<LineProfile> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.line.callbackUrl,
    client_id: config.line.channelId,
    client_secret: config.line.channelSecret,
  });
  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) {
    throw new Error(`LINE のトークン取得に失敗しました (${tokenRes.status})`);
  }
  const token = await tokenRes.json() as { id_token?: string };
  if (!token.id_token) throw new Error("LINE から id_token が返りませんでした");

  // 署名と宛先の検証は LINE の verify に任せる（自前で JWKS を持たない）。
  const verifyRes = await fetch(VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id_token: token.id_token, client_id: config.line.channelId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!verifyRes.ok) throw new Error(`LINE の本人確認に失敗しました (${verifyRes.status})`);
  const claims = await verifyRes.json() as { sub?: string; name?: string; picture?: string };
  if (!claims.sub) throw new Error("LINE のユーザー識別子が取れませんでした");
  return {
    subject: claims.sub,
    displayName: String(claims.name || "").trim().slice(0, 64),
    pictureUrl: String(claims.picture || "").slice(0, 512),
  };
}

function nameKey(name: string): string {
  return name.trim().toLowerCase().slice(0, 64);
}

/**
 * LINE の本人と users を結び付ける。
 *
 * - 既に紐付けがあればその利用者を返す（表示名は上書きしない。
 *   アプリ側で変えた名前を LINE 名で戻さないため）。
 * - ログイン中に呼ばれた場合（linkTo 指定）は、その利用者へ紐付ける。
 * - どちらでもなければ利用者を新しく作る。
 */
export async function resolveLineUser(profile: LineProfile, linkTo = ""): Promise<string> {
  const existing = await all<{ user_id: string }>(
    "SELECT user_id FROM user_identities WHERE provider = 'line' AND subject = ? LIMIT 1",
    [profile.subject],
  );
  if (existing[0]) {
    await pool.query(
      `UPDATE user_identities SET display_name = ?, picture_url = ?
        WHERE provider = 'line' AND subject = ?`,
      [profile.displayName || null, profile.pictureUrl || null, profile.subject],
    );
    return existing[0].user_id;
  }

  let userId = linkTo;
  if (!userId) {
    const name = profile.displayName || "LINEの利用者";
    userId = newId("usr");
    await pool.query(
      "INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)",
      [userId, name, nameKey(name)],
    );
  }
  await pool.query(
    `INSERT INTO user_identities (user_id, provider, subject, display_name, picture_url)
     VALUES (?, 'line', ?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), display_name = VALUES(display_name),
       picture_url = VALUES(picture_url)`,
    [userId, profile.subject, profile.displayName || null, profile.pictureUrl || null],
  );
  return userId;
}

/** コールバックを処理し、ログインさせる利用者 id と戻り先を返す。 */
export async function handleLineCallback(input: {
  code: string;
  state: string;
}): Promise<{ userId: string; returnTo: string; linked: boolean }> {
  const state = readState(input.state);
  if (!state) throw new Error("ログインの手続きが期限切れです。もう一度お試しください");
  if (!input.code) throw new Error("LINE から認可コードが返りませんでした");
  const profile = await exchangeCode(input.code);
  const userId = await resolveLineUser(profile, state.linkTo);
  return { userId, returnTo: safeReturnTo(state.returnTo), linked: Boolean(state.linkTo) };
}

/** この利用者に紐付いている外部ログイン。マイページの表示に使う。 */
export async function identitiesOf(userId: string): Promise<{ provider: string; display_name: string | null }[]> {
  if (!userId) return [];
  return all<{ provider: string; display_name: string | null }>(
    "SELECT provider, display_name FROM user_identities WHERE user_id = ?",
    [userId],
  );
}

/**
 * 紐付けを外す。メール＋パスワードを持たない利用者から外すと、
 * ログインする手段が無くなるので断る。
 */
export async function unlinkLine(userId: string): Promise<void> {
  const credentials = await all<{ user_id: string }>(
    "SELECT user_id FROM user_credentials WHERE user_id = ? LIMIT 1",
    [userId],
  );
  if (!credentials[0]) {
    throw new Error("メールアドレスとパスワードを登録してから解除してください");
  }
  await pool.query("DELETE FROM user_identities WHERE user_id = ? AND provider = 'line'", [userId]);
}
