import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { all, firstRow, pool, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";

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

interface InviteMemberOption {
  userId: string;
  displayName: string;
}

/** ログイン前に招待先と、本人が選べる未登録メンバーを確認する。 */
export async function inspectInvite(token: string): Promise<{
  planSlug: string;
  planTitle: string;
  invitedName: string;
  requiresMemberSelection: boolean;
  memberOptions: InviteMemberOption[];
}> {
  if (!token) throw new BadRequest("招待リンクが無効です");
  const invite = await firstRow<{
    id: string; plan_id: string; status: string; invited_name: string | null;
    invited_user_id: string | null; expires_at: string | null; slug: string; title: string;
  }>(
    pool,
    `SELECT i.id, i.plan_id, i.status, i.invited_name, i.invited_user_id, i.expires_at,
            p.slug, p.title
       FROM plan_invites i
       JOIN plans p ON p.id = i.plan_id AND p.deleted_at IS NULL
      WHERE i.token_hash = ? LIMIT 1`,
    [tokenHash(token)],
  );
  if (!invite || invite.status === "revoked" || invite.status === "expired") {
    throw new BadRequest("この招待リンクは使えません");
  }
  if (invite.status === "accepted") throw new BadRequest("この招待リンクは既に使われています");
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
    throw new BadRequest("この招待リンクは期限切れです");
  }
  const targetPlaceholder = invite.invited_user_id
    ? await firstRow<{ user_id: string }>(
      pool,
      "SELECT user_id FROM plan_member_placeholders WHERE plan_id = ? AND user_id = ? LIMIT 1",
      [invite.plan_id, invite.invited_user_id],
    )
    : null;
  const options = targetPlaceholder || !invite.invited_user_id
    ? await all<{ user_id: string; display_name: string }>(
      `SELECT pmp.user_id, u.display_name
         FROM plan_member_placeholders pmp
         JOIN users u ON u.id = pmp.user_id
         JOIN plan_members pm ON pm.plan_id = pmp.plan_id AND pm.user_id = pmp.user_id AND pm.status = 'active'
        WHERE pmp.plan_id = ? AND pmp.status = 'unclaimed'
        ORDER BY pmp.created_at`,
      [invite.plan_id],
    )
    : [];
  if (targetPlaceholder && !options.length) throw new BadRequest("招待対象のメンバーは既に紐付け済みです");
  return {
    planSlug: invite.slug,
    planTitle: invite.title,
    invitedName: invite.invited_name || "",
    requiresMemberSelection: options.length > 0,
    memberOptions: options.map((row) => ({ userId: row.user_id, displayName: row.display_name })),
  };
}

async function claimPlaceholder(
  conn: mysql.PoolConnection,
  invite: { id: string; plan_id: string; role: "editor" | "viewer"; created_by_id: string; slug: string },
  placeholderUserId: string,
  userId: string,
): Promise<void> {
  const placeholder = await firstRow<{
    user_id: string; role: "owner" | "editor" | "viewer";
    from_date: string | null; to_date: string | null;
  }>(
    conn,
    `SELECT pmp.user_id, pm.role, pm.from_date, pm.to_date
       FROM plan_member_placeholders pmp
       JOIN plan_members pm ON pm.plan_id = pmp.plan_id AND pm.user_id = pmp.user_id AND pm.status = 'active'
      WHERE pmp.plan_id = ? AND pmp.user_id = ? AND pmp.status = 'unclaimed'
      LIMIT 1 FOR UPDATE`,
    [invite.plan_id, placeholderUserId],
  );
  if (!placeholder) throw new BadRequest("選択したメンバーは既に紐付け済みです");
  if (placeholder.role === "owner") throw new BadRequest("Ownerはこの方法では引き継げません");
  const existingMember = await firstRow<{ user_id: string }>(
    conn,
    "SELECT user_id FROM plan_members WHERE plan_id = ? AND user_id = ? AND status = 'active' LIMIT 1 FOR UPDATE",
    [invite.plan_id, userId],
  );
  if (existingMember) throw new BadRequest("このアカウントは既に別のメンバーとして旅行に参加しています");

  await conn.query(
    `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id, from_date, to_date)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    [invite.plan_id, userId, placeholder.role, invite.created_by_id, placeholder.from_date, placeholder.to_date],
  );
  await conn.query(
    "UPDATE expenses SET payer_user_id = ? WHERE plan_id = ? AND payer_user_id = ?",
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    `INSERT INTO expense_shares (expense_id, user_id, amount_base_minor)
     SELECT s.expense_id, ?, s.amount_base_minor
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.plan_id = ? AND s.user_id = ?
     ON DUPLICATE KEY UPDATE amount_base_minor = amount_base_minor + VALUES(amount_base_minor)`,
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    `DELETE s FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.plan_id = ? AND s.user_id = ?`,
    [invite.plan_id, placeholderUserId],
  );
  await conn.query(
    "UPDATE settlements SET from_user_id = ? WHERE plan_id = ? AND from_user_id = ?",
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    "UPDATE settlements SET to_user_id = ? WHERE plan_id = ? AND to_user_id = ?",
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    "UPDATE plan_candidates SET proposed_by_id = ? WHERE plan_id = ? AND proposed_by_id = ?",
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    `INSERT IGNORE INTO plan_candidate_votes (candidate_id, user_id)
     SELECT v.candidate_id, ? FROM plan_candidate_votes v
     JOIN plan_candidates c ON c.id = v.candidate_id
     WHERE c.plan_id = ? AND v.user_id = ?`,
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    `DELETE v FROM plan_candidate_votes v JOIN plan_candidates c ON c.id = v.candidate_id
      WHERE c.plan_id = ? AND v.user_id = ?`,
    [invite.plan_id, placeholderUserId],
  );
  await conn.query(
    `UPDATE plan_member_placeholders
        SET status = 'claimed', claimed_by_user_id = ?, claimed_at = CURRENT_TIMESTAMP
      WHERE plan_id = ? AND user_id = ? AND status = 'unclaimed'`,
    [userId, invite.plan_id, placeholderUserId],
  );
  await conn.query(
    "UPDATE plan_members SET status = 'revoked' WHERE plan_id = ? AND user_id = ?",
    [invite.plan_id, placeholderUserId],
  );
  // 仮メンバーは友達アカウントではない。旧自動作成分があっても本人へ移さない。
  await conn.query("DELETE FROM friendships WHERE user_low_id = ? OR user_high_id = ?", [placeholderUserId, placeholderUserId]);
  await conn.query(
    `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
      WHERE plan_id = ? AND invited_user_id = ? AND id <> ? AND status = 'pending'`,
    [invite.plan_id, placeholderUserId, invite.id],
  );
}

export async function acceptInvite(token: string, userId: string, selectedMemberUserId = ""): Promise<{ planSlug: string }> {
  if (!userId) throw new BadRequest("ログインが必要です");
  return withTransaction(async (conn) => {
    const invite = await firstRow<{
      id: string;
      plan_id: string;
      role: "editor" | "viewer";
      status: "pending" | "accepted" | "revoked" | "expired";
      created_by_id: string;
      invited_user_id: string | null;
      accepted_by_id: string | null;
      expires_at: string | null;
      slug: string;
    }>(
      conn,
      `SELECT i.id, i.plan_id, i.role, i.status, i.created_by_id, i.invited_user_id,
              i.accepted_by_id, i.expires_at, p.slug
         FROM plan_invites i
         JOIN plans p ON p.id = i.plan_id AND p.deleted_at IS NULL
        WHERE i.token_hash = ?
        LIMIT 1
        FOR UPDATE`,
      [tokenHash(token)],
    );
    if (!invite) throw new BadRequest("招待リンクが無効です");
    if (invite.status === "revoked" || invite.status === "expired") throw new BadRequest("この招待リンクは使えません");
    if (invite.status === "accepted") {
      if (invite.accepted_by_id === userId) return { planSlug: invite.slug };
      throw new BadRequest("この招待リンクは既に使われています");
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      await conn.query("UPDATE plan_invites SET status = 'expired' WHERE id = ?", [invite.id]);
      throw new BadRequest("この招待リンクは期限切れです");
    }
    const requestedPlaceholder = String(selectedMemberUserId || "").trim();
    const invitedPlaceholder = invite.invited_user_id
      ? await firstRow<{ user_id: string }>(
        conn,
        "SELECT user_id FROM plan_member_placeholders WHERE plan_id = ? AND user_id = ? LIMIT 1 FOR UPDATE",
        [invite.plan_id, invite.invited_user_id],
      )
      : null;
    if (requestedPlaceholder && invite.invited_user_id && !invitedPlaceholder) {
      throw new BadRequest("この招待リンクではメンバーを選択できません");
    }
    const placeholderUserId = requestedPlaceholder || invitedPlaceholder?.user_id || "";
    if (placeholderUserId) {
      await claimPlaceholder(conn, invite, placeholderUserId, userId);
    } else {
      if (invite.invited_user_id && invite.invited_user_id !== userId) {
        throw new BadRequest("この招待リンクは別のユーザー宛てです");
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
    }
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE plan_invites
          SET status = 'accepted', accepted_by_id = ?, invited_user_id = ?, accepted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'`,
      [userId, userId, invite.id],
    );
    if (updated.affectedRows !== 1 && invite.accepted_by_id !== userId) {
      throw new BadRequest("この招待リンクは既に使われています");
    }
    return { planSlug: invite.slug };
  });
}
