import { inClause, pool, type Row, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { identityKey } from "./identity.js";
import { planRole } from "./plan-access-repo.js";
import { safeDate } from "./repo-helpers.js";

/** 名前だけ分かっている人を、この旅行専用の未登録メンバーとして追加する。 */
export async function createPlaceholderMember(
  planId: string,
  displayName: string,
  actorUserId: string,
): Promise<{ user: { id: string; display_name: string }; member: { plan_id: string; user_id: string; role: "editor"; status: "active" } }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("メンバー名を入力してください");
  const userId = newId("gst");
  await withTransaction(async (conn) => {
    await conn.query(
      "INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)",
      [userId, name, identityKey(name)],
    );
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id)
       VALUES (?, ?, 'editor', 'active', ?)`,
      [planId, userId, actorUserId],
    );
    await conn.query(
      `INSERT INTO plan_member_placeholders
         (plan_id, user_id, original_name, status, created_by_id)
       VALUES (?, ?, ?, 'unclaimed', ?)`,
      [planId, userId, name, actorUserId],
    );
  });
  return {
    user: { id: userId, display_name: name },
    member: { plan_id: planId, user_id: userId, role: "editor", status: "active" },
  };
}

export async function replaceMembers(
  planId: string,
  members: { user_id: string; role?: string; from_date?: string | null; to_date?: string | null }[],
  actorUserId = "",
): Promise<void> {
  const byUserId = new Map<string, {
    user_id: string; role: "owner" | "editor" | "viewer"; from_date: string | null; to_date: string | null;
  }>();
  for (const member of members) {
    const userId = String(member?.user_id || "").trim();
    if (!userId) continue;
    const role = member.role === "owner" || member.role === "viewer" ? member.role : "editor";
    // 合流日が離脱日より後なら、両方無視して「全日程」に倒す（矛盾入力の保険）。
    let fromDate = safeDate(member.from_date);
    let toDate = safeDate(member.to_date);
    if (fromDate && toDate && fromDate > toDate) { fromDate = null; toDate = null; }
    byUserId.set(userId, { user_id: userId, role, from_date: fromDate, to_date: toDate });
  }
  const normalized = [...byUserId.values()];
  const owners = normalized.filter((member) => member.role === "owner");
  const owner = owners[0];
  if (owners.length !== 1) throw new BadRequest("計画には owner が1人だけ必要です");
  if (actorUserId && !normalized.some((member) => member.user_id === actorUserId && member.role === "owner")) {
    throw new BadRequest("自分の owner 権限は残してください。所有権の移譲には専用操作が必要です");
  }

  await withTransaction(async (conn) => {
    const activeIds = normalized.map((member) => member.user_id);
    const activeIn = inClause(activeIds);
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
    const rows = normalized.map((member) =>
      [planId, member.user_id, member.role, "active", member.from_date, member.to_date]);
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status, from_date, to_date) VALUES ?
       ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active',
         from_date = VALUES(from_date), to_date = VALUES(to_date)`,
      [rows],
    );
    const ownerIds = normalized.filter((member) => member.role === "owner").map((member) => member.user_id);
    const ownerIn = inClause(ownerIds);
    const preferredOwner = normalized.some((member) => member.user_id === actorUserId && member.role === "owner")
      ? actorUserId
      : owner.user_id;
    await conn.query(
      `UPDATE plans
       SET owner_user_id = CASE
         WHEN owner_user_id IS NULL OR owner_user_id NOT IN (${ownerIn.sql}) THEN ?
         ELSE owner_user_id
       END
       WHERE id = ?`,
      [...ownerIn.params, preferredOwner, planId],
    );
  });
}

export async function leavePlan(planId: string, userId: string): Promise<void> {
  const role = await planRole(planId, userId);
  if (!role) throw new BadRequest("この計画の参加者ではありません");
  if (role === "owner") {
    throw new BadRequest("所有者は脱退できません。先に所有権を移譲してください");
  }
  await pool.query(
    "UPDATE plan_members SET status = 'left' WHERE plan_id = ? AND user_id = ? AND status = 'active'",
    [planId, userId],
  );
}

export async function transferPlanOwnership(
  planId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  if (!targetUserId || targetUserId === actorUserId) throw new BadRequest("移譲先の参加者を指定してください");
  await withTransaction(async (conn) => {
    const [rows] = await conn.query<Row[]>(
      `SELECT user_id, role FROM plan_members
       WHERE plan_id = ? AND user_id IN (?, ?) AND status = 'active'
       FOR UPDATE`,
      [planId, actorUserId, targetUserId],
    );
    const members = rows as unknown as { user_id: string; role: "owner" | "editor" | "viewer" }[];
    if (!members.some((member) => member.user_id === actorUserId && member.role === "owner")) {
      throw new BadRequest("所有権を移譲できるのは現在の owner だけです");
    }
    if (!members.some((member) => member.user_id === targetUserId)) {
      throw new BadRequest("移譲先は有効な計画参加者である必要があります");
    }
    await conn.query(
      `UPDATE plan_members
       SET role = CASE WHEN user_id = ? THEN 'owner' ELSE 'editor' END
       WHERE plan_id = ? AND (role = 'owner' OR user_id = ?)`,
      [targetUserId, planId, targetUserId],
    );
    await conn.query("UPDATE plans SET owner_user_id = ? WHERE id = ?", [targetUserId, planId]);
  });
}
