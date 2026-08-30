// ユーザープロフィール・設定・友達関係の永続化。
import { all, pool } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { friendshipPair } from "./repo-helpers.js";
import { identityKey } from "./identity.js";

// ---- ユーザー -----------------------------------------------------------

export async function createUser(displayName: string, id?: string): Promise<{ id: string; display_name: string }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  const userId = id || newId("usr");
  await pool.query("INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)", [userId, name, identityKey(name)]);
  return { id: userId, display_name: name };
}


/** 表示名から既存ユーザーを引き、無ければ作る（招待前でも実体を持たせる方針）。 */
export async function ensureUserByName(displayName: string): Promise<{ id: string; display_name: string }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  const found = await all<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM users WHERE name_key = ? ORDER BY created_at LIMIT 1",
    [identityKey(name)],
  );
  if (found[0]) return found[0];
  return createUser(name);
}

export async function renameUser(userId: string, displayName: string): Promise<void> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  await pool.query("UPDATE users SET display_name = ?, name_key = ? WHERE id = ?", [name, identityKey(name), userId]);
}

export async function searchUsers(query: string, actorUserId: string): Promise<
  { id: string; display_name: string; email: string }[]
> {
  if (!actorUserId) throw new BadRequest("ログインが必要です");
  const q = String(query || "").trim().slice(0, 64);
  if (!q) return [];
  // 名前キーもメールも同じ正規化規則。完全一致のときだけメールを返す。
  const key = identityKey(q);
  const rows = await all<{ id: string; display_name: string; email: string | null }>(
    `SELECT u.id, u.display_name, CASE WHEN c.email = ? THEN c.email ELSE '' END AS email
       FROM users u
       LEFT JOIN user_credentials c ON c.user_id = u.id
      WHERE u.id <> ?
        AND (u.name_key LIKE ? OR c.email = ?)
      ORDER BY u.created_at DESC
      LIMIT 20`,
    [key, actorUserId, `%${key}%`, key],
  );
  return rows.map((row) => ({ id: row.id, display_name: row.display_name, email: row.email || "" }));
}

export async function setPaymentLink(userId: string, handle: string): Promise<void> {
  if (!handle) {
    await pool.query("DELETE FROM user_payment_links WHERE user_id = ? AND provider = 'paypay'", [userId]);
    return;
  }
  await pool.query(
    `INSERT INTO user_payment_links (user_id, provider, handle) VALUES (?, 'paypay', ?)
     ON DUPLICATE KEY UPDATE handle = VALUES(handle)`,
    [userId, handle.slice(0, 255)],
  );
}

export async function setUserSettings(userId: string, historyPublic: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO user_settings (user_id, history_public) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE history_public = VALUES(history_public)`,
    [userId, historyPublic ? 1 : 0],
  );
}

// ---- 友達 ---------------------------------------------------------------

export async function friendshipBetween(a: string, b: string): Promise<{
  id: string; requested_by_id: string; status: string;
} | null> {
  const [low, high] = friendshipPair(a, b);
  const rows = await all<{ id: string; requested_by_id: string; status: string }>(
    "SELECT id, requested_by_id, status FROM friendships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1",
    [low, high],
  );
  return rows[0] || null;
}

export async function upsertFriendship(input: {
  a: string; b: string; requested_by_id: string; status?: string;
}): Promise<{ id: string }> {
  const [low, high] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  const existing = await all<{ id: string }>(
    "SELECT id FROM friendships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1", [low, high],
  );
  if (existing[0]) {
    await pool.query(
      `UPDATE friendships
          SET status = ?,
              requested_by_id = CASE WHEN ? = 'pending' THEN ? ELSE requested_by_id END,
              responded_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END
        WHERE id = ?`,
      [input.status || "pending", input.status || "pending", input.requested_by_id, input.status || "pending", existing[0].id],
    );
    return existing[0];
  }
  const id = newId("frd");
  await pool.query(
    "INSERT INTO friendships (id, user_low_id, user_high_id, requested_by_id, status) VALUES (?,?,?,?,?)",
    [id, low, high, input.requested_by_id, input.status || "pending"],
  );
  return { id };
}
