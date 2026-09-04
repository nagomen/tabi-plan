import type mysql from "mysql2/promise";
import type { Row } from "./db.js";

/**
 * 旅行内でメンバーIDを参照する全データを、同じtransaction内で別のIDへ移す。
 * 仮メンバーのclaimとclaim取消の双方がこの処理を使うことで、移行漏れを防ぐ。
 */
export async function reassignPlanMemberReferences(
  conn: mysql.PoolConnection,
  planId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  if (!fromUserId || !toUserId || fromUserId === toUserId) return;

  await conn.query(
    "UPDATE expenses SET payer_user_id = ? WHERE plan_id = ? AND payer_user_id = ?",
    [toUserId, planId, fromUserId],
  );
  await conn.query(
    `INSERT INTO expense_shares (expense_id, user_id, amount_base_minor)
     SELECT s.expense_id, ?, s.amount_base_minor
       FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.plan_id = ? AND s.user_id = ?
     ON DUPLICATE KEY UPDATE amount_base_minor = amount_base_minor + VALUES(amount_base_minor)`,
    [toUserId, planId, fromUserId],
  );
  await conn.query(
    `DELETE s FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
      WHERE e.plan_id = ? AND s.user_id = ?`,
    [planId, fromUserId],
  );
  await conn.query(
    "UPDATE settlements SET from_user_id = ? WHERE plan_id = ? AND from_user_id = ?",
    [toUserId, planId, fromUserId],
  );
  await conn.query(
    "UPDATE settlements SET to_user_id = ? WHERE plan_id = ? AND to_user_id = ?",
    [toUserId, planId, fromUserId],
  );
  await conn.query(
    "UPDATE plan_candidates SET proposed_by_id = ? WHERE plan_id = ? AND proposed_by_id = ?",
    [toUserId, planId, fromUserId],
  );
  await conn.query(
    `INSERT IGNORE INTO plan_candidate_votes (candidate_id, user_id)
     SELECT v.candidate_id, ? FROM plan_candidate_votes v
     JOIN plan_candidates c ON c.id = v.candidate_id
     WHERE c.plan_id = ? AND v.user_id = ?`,
    [toUserId, planId, fromUserId],
  );
  await conn.query(
    `DELETE v FROM plan_candidate_votes v JOIN plan_candidates c ON c.id = v.candidate_id
      WHERE c.plan_id = ? AND v.user_id = ?`,
    [planId, fromUserId],
  );

  // member_idsはTEXT(JSON配列)。壊れた旧JSONはbootstrapと同じく全員扱いなので触らない。
  const [itineraryRows] = await conn.query<Row[]>(
    "SELECT id, member_ids FROM itinerary_items WHERE plan_id = ? AND member_ids IS NOT NULL FOR UPDATE",
    [planId],
  );
  for (const row of itineraryRows as unknown as { id: string; member_ids: string }[]) {
    try {
      const parsed = JSON.parse(String(row.member_ids || "")) as unknown;
      if (!Array.isArray(parsed) || !parsed.includes(fromUserId)) continue;
      const next = [...new Set(parsed.map((id) => id === fromUserId ? toUserId : id))];
      await conn.query("UPDATE itinerary_items SET member_ids = ? WHERE id = ?", [JSON.stringify(next), row.id]);
    } catch {
      // 壊れた旧JSONがあっても、本人紐付けや取消そのものは止めない。
    }
  }
}
