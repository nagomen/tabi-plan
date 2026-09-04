import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { all, firstRow, pool, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { reassignPlanMemberReferences } from "./plan-member-reference-repo.js";

function tokenHash(token: string): Buffer {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

/** 期限切れを業務エラーで返す前に永続化する（例外によるtransaction rollbackを避ける）。 */
async function markExpiredInvites(filter: { token: string } | { planId: string }): Promise<void> {
  if ("token" in filter) {
    await pool.query(
      `UPDATE plan_invites SET status = 'expired'
        WHERE token_hash = ? AND status = 'pending'
          AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`,
      [tokenHash(filter.token)],
    );
    return;
  }
  await pool.query(
    `UPDATE plan_invites SET status = 'expired'
      WHERE plan_id = ? AND status = 'pending'
        AND expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP`,
    [filter.planId],
  );
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
  await withTransaction(async (conn) => {
    const plan = await firstRow<{ owner_user_id: string | null }>(
      conn,
      "SELECT owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [input.planId],
    );
    if (!plan || plan.owner_user_id !== input.createdById) throw new BadRequest("招待を作成できるのは現在のownerだけです");
    // 同じ相手へ再発行した古いリンクは残さない。
    await conn.query(
      `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE plan_id = ? AND status = 'pending' AND invited_user_id <=> ?`,
      [input.planId, invitedUserId],
    );
    await conn.query(
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
  });
  return { id: inviteId, token };
}

export async function listInvites(planId: string): Promise<{
  id: string; role: "editor" | "viewer"; status: string; invited_name: string | null;
  invited_user_id: string | null; accepted_by_id: string | null; expires_at: string | null; created_at: string;
}[]> {
  await markExpiredInvites({ planId });
  return all(
    `SELECT id, role, status, invited_name, invited_user_id, accepted_by_id, expires_at, created_at
       FROM plan_invites WHERE plan_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 200`,
    [planId],
  );
}

export async function revokeInvite(planId: string, inviteId: string, actorUserId: string): Promise<void> {
  await withTransaction(async (conn) => {
    const plan = await firstRow<{ owner_user_id: string | null }>(
      conn,
      "SELECT owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [planId],
    );
    if (!plan || plan.owner_user_id !== actorUserId) throw new BadRequest("招待を取り消せるのは現在のownerだけです");
    const [result] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE plan_invites
          SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE id = ? AND plan_id = ? AND status = 'pending'`,
      [inviteId, planId],
    );
    if (result.affectedRows !== 1) throw new BadRequest("取消できる招待が見つかりません");
  });
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
  await markExpiredInvites({ token });
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
    ? await firstRow<{ user_id: string; display_name: string }>(
      pool,
      `SELECT pmp.user_id, u.display_name
         FROM plan_member_placeholders pmp
         JOIN users u ON u.id = pmp.user_id
         JOIN plan_members pm ON pm.plan_id = pmp.plan_id AND pm.user_id = pmp.user_id AND pm.status = 'active'
        WHERE pmp.plan_id = ? AND pmp.user_id = ? AND pmp.status = 'unclaimed'
        LIMIT 1`,
      [invite.plan_id, invite.invited_user_id],
    )
    : null;
  const options = targetPlaceholder
    ? [targetPlaceholder]
    : !invite.invited_user_id
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
  if (invite.invited_user_id && !targetPlaceholder) {
    const isRegularTarget = await firstRow<{ user_id: string }>(
      pool,
      `SELECT user_id FROM plan_members
        WHERE plan_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
      [invite.plan_id, invite.invited_user_id],
    );
    if (!isRegularTarget) throw new BadRequest("招待対象のメンバーは既に紐付け済みか、旅行から外れています");
  }
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
    "SELECT user_id FROM plan_members WHERE plan_id = ? AND user_id = ? LIMIT 1 FOR UPDATE",
    [invite.plan_id, userId],
  );
  // 既存行があると、claim取消時に「claim前から本人が持っていた旅行データ」と
  // 仮メンバーから移したデータを区別できない。誤った逆移行を防ぐため状態を問わず拒否する。
  if (existingMember) throw new BadRequest("このアカウントは既に別のメンバーとしてこの旅行に登録されています");

  await conn.query(
    `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id, from_date, to_date)
     VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active',
       invited_by_id = VALUES(invited_by_id), from_date = VALUES(from_date), to_date = VALUES(to_date)`,
    [invite.plan_id, userId, invite.role, invite.created_by_id, placeholder.from_date, placeholder.to_date],
  );
  await reassignPlanMemberReferences(conn, invite.plan_id, placeholderUserId, userId);
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
  await markExpiredInvites({ token });
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
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) throw new BadRequest("この招待リンクは期限切れです");
    let membershipChanged = false;
    const requestedPlaceholder = String(selectedMemberUserId || "").trim();
    const invitedPlaceholder = invite.invited_user_id
      ? await firstRow<{ user_id: string }>(
        conn,
        "SELECT user_id FROM plan_member_placeholders WHERE plan_id = ? AND user_id = ? LIMIT 1 FOR UPDATE",
        [invite.plan_id, invite.invited_user_id],
      )
      : null;
    if (invitedPlaceholder && requestedPlaceholder && requestedPlaceholder !== invitedPlaceholder.user_id) {
      throw new BadRequest("この招待リンクは選択したメンバー宛てではありません");
    }
    if (requestedPlaceholder && invite.invited_user_id && !invitedPlaceholder) {
      throw new BadRequest("この招待リンクではメンバーを選択できません");
    }
    if (!invite.invited_user_id) {
      const [placeholderRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT pmp.user_id
           FROM plan_member_placeholders pmp
           JOIN plan_members pm ON pm.plan_id = pmp.plan_id AND pm.user_id = pmp.user_id AND pm.status = 'active'
          WHERE pmp.plan_id = ? AND pmp.status = 'unclaimed' FOR UPDATE`,
        [invite.plan_id],
      );
      const options = new Set((placeholderRows as unknown as { user_id: string }[]).map((row) => row.user_id));
      if (options.size && !requestedPlaceholder) throw new BadRequest("旅行メンバーの中から自分を選択してください");
      if (requestedPlaceholder && !options.has(requestedPlaceholder)) throw new BadRequest("選択したメンバーは招待対象ではありません");
    }
    const placeholderUserId = invitedPlaceholder?.user_id || requestedPlaceholder;
    if (placeholderUserId) {
      await claimPlaceholder(conn, invite, placeholderUserId, userId);
      membershipChanged = true;
    } else {
      if (invite.invited_user_id && invite.invited_user_id !== userId) {
        throw new BadRequest("この招待リンクは別のユーザー宛てです");
      }
      const existing = await firstRow<{ role: "owner" | "editor" | "viewer"; status: string }>(
        conn,
        "SELECT role, status FROM plan_members WHERE plan_id = ? AND user_id = ? LIMIT 1 FOR UPDATE",
        [invite.plan_id, userId],
      );
      if (existing?.status === "active") {
        // 招待の承諾だけで既存権限を昇格・降格させない。
      } else {
        await conn.query(
          `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id)
           VALUES (?, ?, ?, 'active', ?)
           ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active', invited_by_id = VALUES(invited_by_id)`,
          [invite.plan_id, userId, invite.role, invite.created_by_id],
        );
        membershipChanged = true;
      }
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
    if (membershipChanged) {
      await conn.query(
        "UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [invite.plan_id],
      );
    }
    return { planSlug: invite.slug };
  });
}
