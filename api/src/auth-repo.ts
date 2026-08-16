import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import { all, pool, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { identityKey } from "./identity.js";

const pbkdf2 = promisify(crypto.pbkdf2);
const PASSWORD_ITERATIONS = 600_000;

function sessionTokenHash(token: string): Buffer {
  return crypto.createHmac("sha256", config.sessionSecret).update(token, "utf8").digest();
}

export async function createSession(userId: string, ttlMs: number): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await withTransaction(async (conn) => {
    await conn.query("DELETE FROM user_sessions WHERE expires_at < CURRENT_TIMESTAMP OR revoked_at IS NOT NULL");
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
      [newId("ses"), userId, sessionTokenHash(token), expiresAt],
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
    [sessionTokenHash(token), config.sessionEpochMs / 1000],
  );
  return rows[0]?.user_id || "";
}

export async function revokeSession(token: string): Promise<void> {
  if (!token) return;
  await pool.query(
    "UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL",
    [sessionTokenHash(token)],
  );
}

async function passwordHash(password: string, salt: Buffer, iterations = PASSWORD_ITERATIONS): Promise<Buffer> {
  return pbkdf2(String(password || ""), salt, iterations, 32, "sha256");
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function signUp(input: {
  email: string; password: string; displayName: string;
}): Promise<{ user: { id: string; display_name: string; email: string } }> {
  const email = identityKey(input.email);
  const displayName = String(input.displayName || "").trim().slice(0, 64) || email.split("@")[0] || "ユーザー";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequest("メールアドレスの形式が正しくありません");
  if (String(input.password || "").length < 8) throw new BadRequest("パスワードは8文字以上にしてください");
  if (String(input.password || "").length > 256) throw new BadRequest("パスワードは256文字以下にしてください");
  const userId = newId("usr");
  await withTransaction(async (conn) => {
    const [existing] = await conn.query<import("mysql2/promise").RowDataPacket[]>(
      "SELECT user_id FROM user_credentials WHERE email = ? LIMIT 1", [email],
    );
    if (existing.length) throw new BadRequest("このメールアドレスは既に登録されています");
    const salt = crypto.randomBytes(16);
    const hash = await passwordHash(input.password, salt);
    await conn.query(
      "INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)",
      [userId, displayName, identityKey(displayName)],
    );
    await conn.query(
      `INSERT INTO user_credentials (user_id, email, password_salt, password_hash, iterations)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, email, salt, hash, PASSWORD_ITERATIONS],
    );
  });
  return { user: { id: userId, display_name: displayName, email } };
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
  const salt = found?.salt || crypto.randomBytes(16);
  const expected = found?.hash || crypto.randomBytes(32);
  const candidate = await passwordHash(input.password, salt, found?.iterations || PASSWORD_ITERATIONS);
  if (!found || !timingSafeEqual(candidate, expected)) {
    throw new BadRequest("メールアドレスまたはパスワードが違います");
  }
  if (found.iterations < PASSWORD_ITERATIONS) {
    const nextSalt = crypto.randomBytes(16);
    const hash = await passwordHash(input.password, nextSalt, PASSWORD_ITERATIONS);
    await pool.query(
      "UPDATE user_credentials SET password_salt = ?, password_hash = ?, iterations = ? WHERE user_id = ?",
      [nextSalt, hash, PASSWORD_ITERATIONS, found.user_id],
    );
  }
  return { user: { id: found.user_id, display_name: found.display_name, email: found.email } };
}
