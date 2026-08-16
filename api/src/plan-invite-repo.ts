import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { all, pool, type Row, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { ensurePlanMembersAreFriends } from "./plan-member-repo.js";

function tokenHash(token: string): Buffer {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

export async function createInvite(input: {
  planId: string;
  createdById: string;
  invitedName?: string;
  invitedUserId?: string;
  role?: "editor" | "viewer";
}): Promise<{ id: string; token: string }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const inviteId = newId("inv");
  const invitedUserId = String(input.invitedUserId || "").trim() || null;
  if (invitedUserId) {
    const users = await all<{ id: string }>("SELECT id FROM users WHERE id = ? LIMIT 1", [invitedUserId]);
    if (!users.length) throw new BadRequest("招待先のユーザーが見つかりません");
  }
  await pool.query(
    `INSERT INTO plan_invites
       (id, plan_id, token_hash, role, status, invited_name, invited_user_id, created_by_id, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
    [
      inviteId,
      input.planId,
      tokenHash(token),
      input.role === "viewer" ? "viewer" : "editor",
      String(input.invitedName || "").trim().slice(0, 64) || null,
      invitedUserId,
      input.createdById,
    ],
  );
  return { id: inviteId, token };
}

export async function listInvites(planId: string): Promise<{
  id: string; role: "editor" | "viewer"; status: string; invited_name: string | null;
  invited_user_id: string | null; accepted_by_id: string | null; expires_at: string | null; created_at: string;
}[]> {
  return all(
    `SELECT id, role, status, invited_name, invited_user_id, accepted_by_id, expires_at, created_at
       FROM plan_invites WHERE plan_id = ? ORDER BY created_at DESC`,
    [planId],
  );
}

export async function revokeInvite(planId: string, inviteId: string): Promise<void> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE plan_invites
        SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
      WHERE id = ? AND plan_id = ? AND status = 'pending'`,
    [inviteId, planId],
  );
  if (result.affectedRows !== 1) throw new BadRequest("取消できる招待が見つかりません");
}

export async function acceptInvite(token: string, userId: string): Promise<{ planSlug: string }> {
  if (!userId) throw new BadRequest("ログインが必要です");
  return withTransaction(async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT i.id, i.plan_id, i.role, i.status, i.created_by_id, i.invited_user_id,
              i.accepted_by_id, i.expires_at, p.slug
         FROM plan_invites i
         JOIN plans p ON p.id = i.plan_id AND p.deleted_at IS NULL
        WHERE i.token_hash = ?
        LIMIT 1
        FOR UPDATE`,
      [tokenHash(token)],
    );
    const invite = (rows as unknown as {
      id: string;
      plan_id: string;
      role: "editor" | "viewer";
      status: "pending" | "accepted" | "revoked" | "expired";
      created_by_id: string;
      invited_user_id: string | null;
      accepted_by_id: string | null;
      expires_at: string | null;
      slug: string;
    }[])[0];
    if (!invite) throw new BadRequest("招待リンクが無効です");
    if (invite.invited_user_id && invite.invited_user_id !== userId) {
      throw new BadRequest("この招待リンクは別のユーザー宛てです");
    }
    if (invite.status === "revoked" || invite.status === "expired") throw new BadRequest("この招待リンクは使えません");
    if (invite.status === "accepted" && invite.accepted_by_id !== userId) throw new BadRequest("この招待リンクは既に使われています");
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      await conn.query("UPDATE plan_invites SET status = 'expired' WHERE id = ?", [invite.id]);
      throw new BadRequest("この招待リンクは期限切れです");
    }
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id)
       VALUES (?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
         role = IF(role = 'owner', role, VALUES(role)),
         status = 'active',
         invited_by_id = VALUES(invited_by_id)`,
      [invite.plan_id, userId, invite.role, invite.created_by_id],
    );
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE plan_invites
          SET status = 'accepted', accepted_by_id = ?, accepted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'`,
      [userId, invite.id],
    );
    if (updated.affectedRows !== 1 && invite.accepted_by_id !== userId) {
      throw new BadRequest("この招待リンクは既に使われています");
    }
    await ensurePlanMembersAreFriends(invite.plan_id, userId, conn);
    return { planSlug: invite.slug };
  });
}
