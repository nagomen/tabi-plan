import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { config } from "./config.js";
import { all, pool, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { identityKey, isValidEmail } from "./identity.js";
import { hmac } from "./signing.js";
import { hashNewPassword, needsRehash, PASSWORD_ITERATIONS, timingSafeEqual, validatePassword, verifyPassword } from "./password.js";

function newRecoveryCode(): { code: string; hash: Buffer } {
  const code = crypto.randomBytes(18).toString("base64url");
  return { code, hash: hmac(`recovery:${code}`) };
}

type DbExecutor = mysql.Pool | mysql.PoolConnection;

async function revokeOtherSessionsWith(
  executor: DbExecutor,
  userId: string,
  keepToken: string,
): Promise<number> {
  if (!userId) return 0;
  const [result] = await executor.query<mysql.ResultSetHeader>(
    `UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
    [userId, keepToken ? hmac(keepToken) : Buffer.alloc(32)],
  );
  return result.affectedRows || 0;
}

async function insertCredentials(
  conn: mysql.PoolConnection,
  userId: string,
  email: string,
  password: string,
  recoveryHash: Buffer,
): Promise<void> {
  const { salt, hash, iterations } = await hashNewPassword(password);
  await conn.query(
    `INSERT INTO user_credentials
       (user_id, email, password_salt, password_hash, iterations, recovery_code_hash, recovery_code_created_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [userId, email, salt, hash, iterations, recoveryHash],
  );
}

async function replacePasswordAndRecovery(
  conn: mysql.PoolConnection,
  userId: string,
  password: string,
): Promise<{ code: string }> {
  const next = await hashNewPassword(password);
  const recovery = newRecoveryCode();
  await conn.query(
    `UPDATE user_credentials SET password_salt = ?, password_hash = ?, iterations = ?,
       recovery_code_hash = ?, recovery_code_created_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
    [next.salt, next.hash, next.iterations, recovery.hash, userId],
  );
  return recovery;
}

export async function createSession(userId: string, ttlMs: number): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  // 期限切れセッションの掃除は単なる衛生処理。ログインのトランザクションに
  // 入れるとテーブル全体のロック競合（デッドロック）源になるため、外で
  // 失敗してもよい形で実行する。
  void pool.query("DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP OR revoked_at IS NOT NULL")
    .catch((error) => console.warn("[travel-api] session sweep failed", error));
  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND revoked_at IS NULL AND id NOT IN (
          SELECT id FROM (
            SELECT id FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL
            ORDER BY created_at DESC LIMIT 19
          ) recent
        )`,
      [userId, userId],
    );
    await conn.query(
      "INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
      [newId("ses"), userId, hmac(token), expiresAt],
    );
  });
  return token;
}

export async function resolveSession(token: string): Promise<string> {
  if (!token) return "";
  const rows = await all<{ user_id: string }>(
    `SELECT user_id FROM user_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
        AND created_at >= FROM_UNIXTIME(?)
      LIMIT 1`,
    [hmac(token), config.sessionEpochMs / 1000],
  );
  return rows[0]?.user_id || "";
}

/**
 * この人の他の端末のセッションを全部切る。
 *
 * 端末を失くしたときや、パスワードを変えたときの後始末に使う。
 * いま使っているトークンだけ残すので、操作した端末は開いたままになる。
 */
export async function revokeOtherSessions(userId: string, keepToken: string): Promise<number> {
  return revokeOtherSessionsWith(pool, userId, keepToken);
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await pool.query(
    "UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL",
    [hmac(token)],
  );
}

export async function signUp(input: {
  email: string; password: string; displayName: string;
}): Promise<{ user: { id: string; display_name: string; email: string }; recovery_code: string }> {
  const email = identityKey(input.email);
  const displayName = String(input.displayName || "").trim().slice(0, 64) || email.split("@")[0] || "ユーザー";
  if (!isValidEmail(email)) throw new BadRequest("メールアドレスの形式が正しくありません");
  validatePassword(input.password);
  const userId = newId("usr");
  const recovery = newRecoveryCode();
  try {
    await withTransaction(async (conn) => {
      const [existing] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
        "SELECT user_id FROM user_credentials WHERE email = ? LIMIT 1", [email],
      );
      if (existing.length) throw new BadRequest("このメールアドレスは既に登録されています");
      await conn.query(
        "INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)",
        [userId, displayName, identityKey(displayName)],
      );
      await insertCredentials(conn, userId, email, input.password, recovery.hash);
    });
  } catch (error) {
    // SELECT→INSERT の間に同じメールで登録が走った場合。事前チェックと同じ文言で返す。
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new BadRequest("このメールアドレスは既に登録されています");
    }
    throw error;
  }
  return { user: { id: userId, display_name: displayName, email }, recovery_code: recovery.code };
}

export async function logIn(input: {
  email: string; password: string;
}): Promise<{ user: { id: string; display_name: string; email: string } }> {
  const email = identityKey(input.email);
  const rows = await all<{
    user_id: string; display_name: string; email: string; salt: Buffer; hash: Buffer; iterations: number;
  }>(
    `SELECT c.user_id, u.display_name, c.email, c.password_salt AS salt, c.password_hash AS hash, c.iterations
       FROM user_credentials c JOIN users u ON u.id = c.user_id
      WHERE c.email = ? LIMIT 1`,
    [email],
  );
  const found = rows[0];
  // 該当なしでもダミーのハッシュ照合を行い、応答時間で存在有無を漏らさない。
  const stored = found
    ? { salt: found.salt, hash: found.hash, iterations: found.iterations }
    : { salt: crypto.randomBytes(16), hash: crypto.randomBytes(32), iterations: PASSWORD_ITERATIONS };
  const ok = await verifyPassword(input.password, stored);
  if (!found || !ok) {
    throw new BadRequest("メールアドレスまたはパスワードが違います");
  }
  if (needsRehash(found.iterations)) {
    const next = await hashNewPassword(input.password);
    await pool.query(
      "UPDATE user_credentials SET password_salt = ?, password_hash = ?, iterations = ? WHERE user_id = ?",
      [next.salt, next.hash, next.iterations, found.user_id],
    );
  }
  return { user: { id: found.user_id, display_name: found.display_name, email: found.email } };
}

/**
 * パスワードを変える。いまのパスワードを確かめてから差し替える。
 *
 * パスワード更新・復旧コード更新・他端末の失効は、途中失敗で半端にならないよう同じtransactionで行う。
 */
export async function changePassword(input: {
  userId: string; currentPassword: string; newPassword: string; keepToken: string;
}): Promise<{ recovery_code: string; revoked: number }> {
  const next = validatePassword(input.newPassword);
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
      `SELECT password_salt AS salt, password_hash AS hash, iterations
         FROM user_credentials WHERE user_id = ? LIMIT 1 FOR UPDATE`,
      [input.userId],
    );
    const found = rows[0] as { salt: Buffer; hash: Buffer; iterations: number } | undefined;
    if (!found) throw new BadRequest("メールアドレスとパスワードが登録されていません");
    if (!(await verifyPassword(input.currentPassword, found))) throw new BadRequest("いまのパスワードが違います");
    const recovery = await replacePasswordAndRecovery(conn, input.userId, next);
    const revoked = await revokeOtherSessionsWith(conn, input.userId, input.keepToken);
    return { recovery_code: recovery.code, revoked };
  });
}

/**
 * LINE だけで作ったアカウントに、メールアドレスとパスワードを足す。
 *
 * これが無いと、LINE を使えなくなった時点でアカウントへ入れなくなる
 * （メール送信の口がまだ無いので、再設定メールも送れない）。
 */
export async function addCredentials(input: {
  userId: string; email: string; password: string;
}): Promise<{ email: string; recovery_code: string }> {
  const email = identityKey(input.email);
  if (!isValidEmail(email)) throw new BadRequest("メールアドレスの形式が正しくありません");
  const password = validatePassword(input.password);
  const recovery = newRecoveryCode();
  try {
    await withTransaction(async (conn) => {
      const [mine] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
        "SELECT user_id FROM user_credentials WHERE user_id = ? LIMIT 1", [input.userId],
      );
      if (mine.length) throw new BadRequest("すでにメールアドレスが登録されています");
      const [taken] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
        "SELECT user_id FROM user_credentials WHERE email = ? LIMIT 1", [email],
      );
      if (taken.length) throw new BadRequest("このメールアドレスは既に登録されています");
      await insertCredentials(conn, input.userId, email, password, recovery.hash);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      throw new BadRequest("このメールアドレスは既に登録されています");
    }
    throw error;
  }
  return { email, recovery_code: recovery.code };
}

/** メール配送に依存しない復旧コードでパスワードを再設定し、全端末をログアウトする。 */
export async function recoverPassword(input: {
  email: string; recoveryCode: string; newPassword: string;
}): Promise<{ recovery_code: string }> {
  const email = identityKey(input.email);
  if (!isValidEmail(email)) throw new BadRequest("メールアドレスまたは復旧コードが違います");
  const nextPassword = validatePassword(input.newPassword);
  const candidate = hmac(`recovery:${String(input.recoveryCode || "")}`);
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT user_id, recovery_code_hash FROM user_credentials WHERE email = ? LIMIT 1 FOR UPDATE",
      [email],
    );
    const found = rows[0] as { user_id: string; recovery_code_hash: Buffer | null } | undefined;
    const stored = found?.recovery_code_hash || crypto.randomBytes(32);
    if (!found || !timingSafeEqual(candidate, stored)) {
      throw new BadRequest("メールアドレスまたは復旧コードが違います");
    }
    const recovery = await replacePasswordAndRecovery(conn, found.user_id, nextPassword);
    await conn.query(
      "UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL",
      [found.user_id],
    );
    return { recovery_code: recovery.code };
  });
}

/** ログイン中の本人へ新しい復旧コードを一度だけ返す。古いコードは即時失効する。 */
export async function rotateRecoveryCode(userId: string): Promise<{ recovery_code: string }> {
  const recovery = newRecoveryCode();
  const [result] = await pool.query<import("mysql2/promise").ResultSetHeader>(
    `UPDATE user_credentials
        SET recovery_code_hash = ?, recovery_code_created_at = CURRENT_TIMESTAMP
      WHERE user_id = ?`,
    [recovery.hash, userId],
  );
  if (!result.affectedRows) throw new BadRequest("先にメールアドレスとパスワードを登録してください");
  return { recovery_code: recovery.code };
}
