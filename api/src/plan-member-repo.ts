import mysql from "mysql2/promise";
import { inClause, pool, type Row, withTransaction } from "./db.js";
import { BadRequest } from "./errors.js";
import { newId } from "./ids.js";
import { planRole } from "./plan-access-repo.js";
import { activeMemberIds, friendshipPair } from "./repo-helpers.js";

async function ensureAcceptedFriendship(
  a: string,
  b: string,
  requestedById: string,
  conn: mysql.PoolConnection | mysql.Pool = pool,
): Promise<void> {
  if (!a || !b || a === b) return;
  const [low, high] = friendshipPair(a, b);
  await conn.query(
    `INSERT INTO friendships (id, user_low_id, user_high_id, requested_by_id, status, responded_at)
     VALUES (?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       status = 'accepted',
       responded_at = CURRENT_TIMESTAMP`,
    [newId("frd"), low, high, requestedById],
  );
}

export async function ensurePlanMembersAreFriends(
  planId: string,
  requestedById: string,
  conn: mysql.PoolConnection | mysql.Pool = pool,
): Promise<void> {
  const ids = Array.from(new Set(await activeMemberIds(planId, conn)));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      await ensureAcceptedFriendship(ids[i], ids[j], requestedById, conn);
    }
  }
}

export async function replaceMembers(
  planId: string,
  members: { user_id: string; role?: string }[],
  actorUserId = "",
): Promise<void> {
  const byUserId = new Map<string, { user_id: string; role: "owner" | "editor" | "viewer" }>();
  for (const member of members) {
    const userId = String(member?.user_id || "").trim();
    if (!userId) continue;
    const role = member.role === "owner" || member.role === "viewer" ? member.role : "editor";
    byUserId.set(userId, { user_id: userId, role });
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
    const rows = normalized.map((member) => [planId, member.user_id, member.role, "active"]);
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status) VALUES ?
       ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active'`,
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
    await ensurePlanMembersAreFriends(planId, actorUserId || owner.user_id, conn);
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
