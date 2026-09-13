import type mysql from "mysql2/promise";
import { safeDate } from "./coerce.js";
import { firstRow, inClause, type Row, withTransaction } from "./db.js";
import { BadRequest, VersionConflict } from "./errors.js";
import { newId } from "./ids.js";
import { identityKey } from "./identity.js";
import { reassignPlanMemberReferences } from "./plan-member-reference-repo.js";

/**
 * 指定メンバーが費用・負担・精算で参照されている件数。
 * メンバー除外（replaceMembers）と脱退（leavePlan）の双方が同じ基準で判定する。
 */
async function memberReferenceCount(
  conn: mysql.PoolConnection,
  planId: string,
  userIds: string[],
): Promise<number> {
  if (!userIds.length) return 0;
  const idsIn = inClause(userIds);
  const referenced = await firstRow<{ total: number }>(
    conn,
    `SELECT (
       (SELECT COUNT(*) FROM expenses e
         WHERE e.plan_id = ? AND e.deleted_at IS NULL AND e.payer_user_id IN (${idsIn.sql})) +
       (SELECT COUNT(*) FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
         WHERE e.plan_id = ? AND e.deleted_at IS NULL AND s.user_id IN (${idsIn.sql})) +
       (SELECT COUNT(*) FROM settlements s
         WHERE s.plan_id = ? AND s.deleted_at IS NULL
           AND (s.from_user_id IN (${idsIn.sql}) OR s.to_user_id IN (${idsIn.sql})))
     ) AS total`,
    [planId, ...idsIn.params, planId, ...idsIn.params, planId, ...idsIn.params, ...idsIn.params],
  );
  return Number(referenced?.total || 0);
}

/** 名前だけ分かっている人を、この旅行専用の未登録メンバーとして追加する。 */
export async function createPlaceholderMember(
  planId: string,
  displayName: string,
  actorUserId: string,
  role: "editor" | "viewer" = "editor",
): Promise<{ user: { id: string; display_name: string }; member: { plan_id: string; user_id: string; role: "editor" | "viewer"; status: "active"; access_status: null }; version: number }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("メンバー名を入力してください");
  const userId = newId("gst");
  const version = await withTransaction(async (conn) => {
    const plan = await firstRow<{ owner_user_id: string | null; version: number }>(
      conn,
      "SELECT owner_user_id, version FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [planId],
    );
    if (!plan || plan.owner_user_id !== actorUserId) throw new BadRequest("メンバーを追加できるのは現在のownerだけです");
    await conn.query(
      "INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)",
      [userId, name, identityKey(name)],
    );
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id)
       VALUES (?, ?, ?, 'active', ?)`,
      [planId, userId, role, actorUserId],
    );
    await conn.query(
      `INSERT INTO plan_member_placeholders
         (plan_id, user_id, original_name, status, created_by_id)
       VALUES (?, ?, ?, 'unclaimed', ?)`,
      [planId, userId, name, actorUserId],
    );
    await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
    return Number(plan.version || 0) + 1;
  });
  return {
    user: { id: userId, display_name: name },
    member: { plan_id: planId, user_id: userId, role, status: "active", access_status: null },
    version,
  };
}

export async function replaceMembers(
  planId: string,
  members: { user_id: string; role?: string; from_date?: string | null; to_date?: string | null }[],
  actorUserId: string,
  expectedVersion: number,
): Promise<number> {
  const byUserId = new Map<string, {
    user_id: string; role: "owner" | "editor" | "viewer"; from_date: string | null; to_date: string | null;
  }>();
  for (const member of members) {
    const userId = String(member?.user_id || "").trim();
    if (!userId) continue;
    const role = member.role === "owner" || member.role === "viewer" ? member.role : "editor";
    let fromDate = safeDate(member.from_date);
    let toDate = safeDate(member.to_date);
    if (fromDate && toDate && fromDate > toDate) throw new BadRequest("参加開始日は参加終了日以前にしてください");
    byUserId.set(userId, { user_id: userId, role, from_date: fromDate, to_date: toDate });
  }
  const normalized = [...byUserId.values()];
  const owners = normalized.filter((member) => member.role === "owner");
  const owner = owners[0];
  if (owners.length !== 1) throw new BadRequest("計画には owner が1人だけ必要です");
  if (!normalized.some((member) => member.user_id === actorUserId && member.role === "owner")) {
    throw new BadRequest("自分の owner 権限は残してください。所有権の移譲には専用操作が必要です");
  }

  return withTransaction(async (conn) => {
    const plan = await firstRow<{
      version: number; start_date: string | null; end_date: string | null; owner_user_id: string | null;
    }>(
      conn,
      "SELECT version, start_date, end_date, owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [planId],
    );
    if (!plan) throw new BadRequest("計画が見つかりません");
    if (plan.owner_user_id !== actorUserId) throw new BadRequest("メンバーを変更できるのは現在のownerだけです");
    const currentVersion = Number(plan.version || 0);
    if (expectedVersion !== currentVersion) {
      throw new VersionConflict("メンバーが別の端末で更新されています", currentVersion);
    }
    for (const member of normalized) {
      if (plan.start_date && member.from_date && member.from_date < plan.start_date) {
        throw new BadRequest("参加開始日は旅行開始日以降にしてください");
      }
      if (plan.end_date && member.from_date && member.from_date > plan.end_date) {
        throw new BadRequest("参加開始日は旅行終了日以前にしてください");
      }
      if (plan.start_date && member.to_date && member.to_date < plan.start_date) {
        throw new BadRequest("参加終了日は旅行開始日以降にしてください");
      }
      if (plan.end_date && member.to_date && member.to_date > plan.end_date) {
        throw new BadRequest("参加終了日は旅行終了日以前にしてください");
      }
    }
    const activeIds = normalized.map((member) => member.user_id);
    const activeIn = inClause(activeIds);
    const [knownRows] = await conn.query<Row[]>(
      `SELECT id FROM users WHERE id IN (${activeIn.sql}) FOR UPDATE`,
      activeIn.params,
    );
    if (knownRows.length !== activeIds.length) throw new BadRequest("存在しないユーザーがメンバーに含まれています");
    const ownerPlaceholder = await firstRow<{ user_id: string }>(
      conn,
      `SELECT user_id FROM plan_member_placeholders
        WHERE plan_id = ? AND user_id = ? AND status = 'unclaimed' LIMIT 1 FOR UPDATE`,
      [planId, owner.user_id],
    );
    if (ownerPlaceholder) throw new BadRequest("未登録メンバーをownerにはできません");

    const [currentRows] = await conn.query<Row[]>(
      "SELECT user_id FROM plan_members WHERE plan_id = ? AND status = 'active' FOR UPDATE",
      [planId],
    );
    const nextIds = new Set(activeIds);
    const removedIds = (currentRows as unknown as { user_id: string }[])
      .map((row) => row.user_id)
      .filter((id) => !nextIds.has(id));
    if (await memberReferenceCount(conn, planId, removedIds) > 0) {
      throw new BadRequest("費用・負担・精算に使われているメンバーは削除できません。会計履歴を残して権限だけ外す場合は、アクセス停止を使ってください");
    }
    await conn.query(
      `UPDATE plan_members SET status = 'revoked'
       WHERE plan_id = ? AND user_id NOT IN (${activeIn.sql})`,
      [planId, ...activeIn.params],
    );
    await conn.query(
      `UPDATE plan_member_placeholders
          SET status = 'removed'
        WHERE plan_id = ? AND status = 'unclaimed' AND user_id NOT IN (${activeIn.sql})`,
      [planId, ...activeIn.params],
    );
    if (removedIds.length) {
      const removedIn = inClause(removedIds);
      await conn.query(
        `UPDATE plan_access_grants SET status = 'revoked'
          WHERE plan_id = ? AND user_id IN (${removedIn.sql}) AND status = 'active'`,
        [planId, ...removedIn.params],
      );
      await conn.query(
        `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
          WHERE plan_id = ? AND invited_user_id IN (${removedIn.sql}) AND status = 'pending'`,
        [planId, ...removedIn.params],
      );
    }
    const rows = normalized.map((member) =>
      [planId, member.user_id, member.role, "active", member.from_date, member.to_date]);
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status, from_date, to_date) VALUES ?
       ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active',
         from_date = VALUES(from_date), to_date = VALUES(to_date)`,
      [rows],
    );
    await conn.query(
      `UPDATE plans
       SET owner_user_id = ?,
       version = version + 1,
       updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [owner.user_id, planId],
    );
    await conn.query(
      `INSERT INTO plan_access_grants (plan_id, user_id, role, status, granted_by_id)
       VALUES (?, ?, 'owner', 'active', ?)
       ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
      [planId, owner.user_id, actorUserId],
    );
    await conn.query(
      `UPDATE plan_access_grants pag
       JOIN plan_members pm ON pm.plan_id = pag.plan_id AND pm.user_id = pag.user_id
          SET pag.role = pm.role
        WHERE pag.plan_id = ? AND pag.status = 'active' AND pm.status = 'active'`,
      [planId],
    );
    // 未受諾の対象者別リンクも、画面で選んだ最新ロールへ揃える。
    await conn.query(
      `UPDATE plan_invites i
       JOIN plan_members pm ON pm.plan_id = i.plan_id AND pm.user_id = i.invited_user_id
          SET i.role = pm.role
        WHERE i.plan_id = ? AND i.status = 'pending' AND pm.status = 'active'`,
      [planId],
    );
    return currentVersion + 1;
  });
}

export async function leavePlan(planId: string, userId: string): Promise<void> {
  await withTransaction(async (conn) => {
    const plan = await firstRow<{ owner_user_id: string | null }>(
      conn, "SELECT owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE", [planId],
    );
    const member = await firstRow<{ role: string; status: string }>(
      conn, "SELECT role, status FROM plan_members WHERE plan_id = ? AND user_id = ? LIMIT 1 FOR UPDATE", [planId, userId],
    );
    if (!plan || member?.status !== "active") throw new BadRequest("この計画の参加者ではありません");
    if (plan.owner_user_id === userId || member.role === "owner") {
      throw new BadRequest("所有者は脱退できません。先に所有権を移譲してください");
    }
    // 会計履歴から参照されている人は、金額と表示名を壊さないよう旅行上の参加者として残す。
    // アプリへのアクセス権は別テーブルなので、履歴の有無にかかわらず即時に脱退できる。
    if (await memberReferenceCount(conn, planId, [userId]) === 0) {
      await conn.query(
        "UPDATE plan_members SET status = 'left' WHERE plan_id = ? AND user_id = ? AND status = 'active'",
        [planId, userId],
      );
    }
    await conn.query(
      "UPDATE plan_access_grants SET status = 'revoked' WHERE plan_id = ? AND user_id = ? AND status = 'active'",
      [planId, userId],
    );
    await conn.query(
      `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE plan_id = ? AND invited_user_id = ? AND status = 'pending'`,
      [planId, userId],
    );
    await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
  });
}

/** ownerが会計上の参加者を残したまま、対象アカウントの閲覧・編集権だけを即時停止する。 */
export async function revokeMemberAccess(
  planId: string,
  targetUserId: string,
  actorUserId: string,
): Promise<void> {
  if (!targetUserId || targetUserId === actorUserId) throw new BadRequest("自分自身のアクセスは停止できません");
  await withTransaction(async (conn) => {
    const plan = await firstRow<{ owner_user_id: string | null }>(
      conn,
      "SELECT owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [planId],
    );
    if (!plan || plan.owner_user_id !== actorUserId) {
      throw new BadRequest("アクセスを停止できるのは現在のownerだけです");
    }
    if (plan.owner_user_id === targetUserId) throw new BadRequest("ownerのアクセスは停止できません");
    const member = await firstRow<{ status: string }>(
      conn,
      "SELECT status FROM plan_members WHERE plan_id = ? AND user_id = ? LIMIT 1 FOR UPDATE",
      [planId, targetUserId],
    );
    if (member?.status !== "active") throw new BadRequest("対象の旅行参加者が見つかりません");
    const [result] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE plan_access_grants SET status = 'revoked'
        WHERE plan_id = ? AND user_id = ? AND status = 'active'`,
      [planId, targetUserId],
    );
    if (result.affectedRows !== 1) throw new BadRequest("対象者の有効なアクセス権が見つかりません");
    await conn.query(
      `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE plan_id = ? AND invited_user_id = ? AND status = 'pending'`,
      [planId, targetUserId],
    );
    await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
  });
}

export async function transferPlanOwnership(
  planId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  if (!targetUserId || targetUserId === actorUserId) throw new BadRequest("移譲先の参加者を指定してください");
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT pm.user_id, pm.role FROM plan_members pm
       JOIN plan_access_grants pag
         ON pag.plan_id = pm.plan_id AND pag.user_id = pm.user_id AND pag.status = 'active'
       WHERE pm.plan_id = ? AND pm.user_id IN (?, ?) AND pm.status = 'active'
       FOR UPDATE`,
      [planId, actorUserId, targetUserId],
    );
    const members = rows as unknown as { user_id: string; role: "owner" | "editor" | "viewer" }[];
    if (!members.some((member) => member.user_id === actorUserId && member.role === "owner")) {
      throw new BadRequest("所有権を移譲できるのは現在の owner だけです");
    }
    if (!members.some((member) => member.user_id === targetUserId)) {
      throw new BadRequest("移譲先は招待を受諾済みの計画参加者である必要があります");
    }
    const placeholder = await firstRow<{ user_id: string }>(
      conn,
      `SELECT user_id FROM plan_member_placeholders
        WHERE plan_id = ? AND user_id = ? AND status = 'unclaimed' LIMIT 1 FOR UPDATE`,
      [planId, targetUserId],
    );
    if (placeholder) throw new BadRequest("未登録メンバーへ所有権は移譲できません。先に本人のアカウントを紐付けてください");
    await conn.query(
      `UPDATE plan_members
       SET role = CASE WHEN user_id = ? THEN 'owner' ELSE 'editor' END
       WHERE plan_id = ? AND (role = 'owner' OR user_id = ?)`,
      [targetUserId, planId, targetUserId],
    );
    await conn.query(
      `INSERT INTO plan_access_grants (plan_id, user_id, role, status, granted_by_id)
       VALUES (?, ?, 'owner', 'active', ?)
       ON DUPLICATE KEY UPDATE role = 'owner', status = 'active', granted_by_id = VALUES(granted_by_id)`,
      [planId, targetUserId, actorUserId],
    );
    await conn.query(
      `UPDATE plan_access_grants SET role = 'editor'
        WHERE plan_id = ? AND user_id = ? AND status = 'active'`,
      [planId, actorUserId],
    );
    await conn.query(
      "UPDATE plans SET owner_user_id = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [targetUserId, planId],
    );
    await conn.query(
      `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE plan_id = ? AND status = 'pending'`,
      [planId],
    );
  });
}

/** ownerが誤った本人紐付けを取り消し、旅行内データを元の仮メンバーへ戻す。 */
export async function undoPlaceholderClaim(
  planId: string,
  placeholderUserId: string,
  actorUserId: string,
): Promise<void> {
  await withTransaction(async (conn) => {
    const plan = await firstRow<{ owner_user_id: string | null }>(
      conn,
      "SELECT owner_user_id FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [planId],
    );
    if (!plan || plan.owner_user_id !== actorUserId) throw new BadRequest("本人紐付けを取り消せるのは現在のownerだけです");
    const claim = await firstRow<{ claimed_by_user_id: string; claimed_role: string }>(
      conn,
      `SELECT pmp.claimed_by_user_id, pm.role AS claimed_role
         FROM plan_member_placeholders pmp
         JOIN plan_members pm ON pm.plan_id = pmp.plan_id AND pm.user_id = pmp.claimed_by_user_id
        WHERE pmp.plan_id = ? AND pmp.user_id = ? AND pmp.status = 'claimed'
        LIMIT 1 FOR UPDATE`,
      [planId, placeholderUserId],
    );
    if (!claim?.claimed_by_user_id) throw new BadRequest("取り消せる本人紐付けが見つかりません");
    if (claim.claimed_role === "owner") throw new BadRequest("ownerの本人紐付けは取り消せません。先に所有権を移譲してください");
    const claimedUserId = claim.claimed_by_user_id;

    await reassignPlanMemberReferences(conn, planId, claimedUserId, placeholderUserId);
    await conn.query(
      `UPDATE plan_member_placeholders
          SET status = 'unclaimed', claimed_by_user_id = NULL, claimed_at = NULL
        WHERE plan_id = ? AND user_id = ?`,
      [planId, placeholderUserId],
    );
    await conn.query("UPDATE plan_members SET status = 'active' WHERE plan_id = ? AND user_id = ?", [planId, placeholderUserId]);
    await conn.query("UPDATE plan_members SET status = 'revoked' WHERE plan_id = ? AND user_id = ?", [planId, claimedUserId]);
    await conn.query("UPDATE plan_access_grants SET status = 'revoked' WHERE plan_id = ? AND user_id = ?", [planId, claimedUserId]);
    await conn.query(
      `UPDATE plan_invites SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP
        WHERE plan_id = ? AND invited_user_id = ? AND status = 'pending'`,
      [planId, claimedUserId],
    );
    await conn.query(
      "UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_user_id = ?",
      [planId, actorUserId],
    );
  });
}
