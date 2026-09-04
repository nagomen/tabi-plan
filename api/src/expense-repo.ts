// 費用・負担割・精算・監査ログの永続化。
import mysql from "mysql2/promise";
import { all, firstRow, type Row, withTransaction } from "./db.js";
import { BadRequest, Forbidden, NotFound } from "./errors.js";
import { newId } from "./ids.js";
import { activeMemberSet, assertMember, safeUrl } from "./repo-helpers.js";

// ---- 費用 ---------------------------------------------------------------

export interface ExpenseInput {
  id?: string;
  paid_on?: string | null;
  payer_user_id: string;
  category?: string;
  title?: string;
  amount_minor: number;
  currency?: string;
  fx_rate?: number;
  split_method?: string;
  payment_method?: string | null;
  note?: string | null;
  receipt_url?: string | null;
  shares: { user_id: string; amount_base_minor: number }[];
}

const CATEGORIES = new Set(["food", "transport", "lodging", "sightseeing", "communication", "other"]);
const SPLIT = new Set(["equal_all", "equal_selected", "custom", "none"]);
const PAY = new Set(["card", "cash", "transfer", "other"]);

/** ルート判定後の権限変更競合を防ぎ、書き込みtransaction内でも編集権限を確認する。 */
async function assertWorkspaceEditor(conn: mysql.PoolConnection, planId: string, actorUserId: string): Promise<void> {
  const access = await firstRow<{ role: string; source: string }>(
    conn,
    `SELECT pm.role, p.source FROM plans p
       JOIN plan_members pm ON pm.plan_id = p.id AND pm.user_id = ? AND pm.status = 'active'
      WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1 FOR UPDATE`,
    [actorUserId, planId],
  );
  if (!access || access.source === "sample" || !["owner", "editor"].includes(access.role)) {
    throw new Forbidden("費用・精算を変更する権限がありません");
  }
}

/** 支払額・レート・base_currency 換算額を検証つきで求める。create/update で共有する。 */
export function computeAmounts(input: ExpenseInput): { amount: number; rate: number; base: number } {
  const amount = Math.round(Number(input.amount_minor) || 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new BadRequest("支払額は1以上の整数で指定してください");
  // レート未指定は1（同一通貨）。指定されたのに不正な値を黙って1へ倒すと
  // 金額が変わってしまうので、Infinity・0以下・巨大値はここで400にする。
  const provided = input.fx_rate !== undefined && input.fx_rate !== null && String(input.fx_rate) !== "";
  const rawRate = Number(input.fx_rate);
  if (provided && (!Number.isFinite(rawRate) || rawRate <= 0 || rawRate > 1_000_000)) {
    throw new BadRequest("換算レートの値が正しくありません");
  }
  const rate = provided ? rawRate : 1;
  const base = Math.round(amount * rate);
  if (!Number.isSafeInteger(base) || base <= 0) throw new BadRequest("換算後の金額が扱える範囲を超えています");
  return { amount, rate, base };
}

/** 支払日はDBのDATE型に入る前に検査する。空は「日付未設定」として通す。 */
export function paidOnOrNull(value: unknown): string | null {
  const text = String(value || "");
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new BadRequest("支払日の形式が正しくありません");
  return text;
}

export function normalizeShares(shares: unknown): { user_id: string; amount_base_minor: number }[] {
  const byUser = new Map<string, number>();
  for (const share of Array.isArray(shares) ? shares : []) {
    if (!share || typeof share !== "object" || Array.isArray(share)) continue;
    const value = share as Record<string, unknown>;
    const userId = String(value.user_id || "").trim();
    const amount = Math.round(Number(value.amount_base_minor) || 0);
    if (!userId || amount <= 0) continue;
    byUser.set(userId, (byUser.get(userId) || 0) + amount);
  }
  return [...byUser.entries()].map(([user_id, amount_base_minor]) => ({ user_id, amount_base_minor }));
}

/**
 * 割り勘・精算の金額整合を検証する純粋関数（DB非依存）。
 * 参加者集合は呼び出し側が渡す。負担額合計＝支払額、精算不要は負担0、
 * 支払者・負担者は参加者であること。
 */
export function validateShares(
  input: ExpenseInput,
  base: number,
  memberIds: Set<string>,
): { splitMethod: string; shares: { user_id: string; amount_base_minor: number }[] } {
  const splitMethod = SPLIT.has(String(input.split_method)) ? String(input.split_method) : "equal_all";
  assertMember(memberIds, String(input.payer_user_id || ""), "支払者");
  const shares = normalizeShares(input.shares);
  for (const share of shares) assertMember(memberIds, share.user_id, "負担者");
  const shareTotal = shares.reduce((sum, share) => sum + share.amount_base_minor, 0);
  if (splitMethod === "none") {
    if (shareTotal !== 0) throw new BadRequest("精算不要の費用には負担額を設定できません");
  } else if (shareTotal !== base) {
    throw new BadRequest("負担額の合計が支払額と一致していません");
  }
  return { splitMethod, shares };
}

/** 費用を1件追加する。行の INSERT なので、複数端末の同時追加でも衝突しない。 */
export async function createExpense(planId: string, input: ExpenseInput, actorUserId: string): Promise<{ id: string }> {
  const id = input.id && /^[\w-]{1,32}$/.test(input.id) ? input.id : newId("exp");
  const { amount, rate, base } = computeAmounts(input);
  await withTransaction(async (conn) => {
    await assertWorkspaceEditor(conn, planId, actorUserId);
    const { splitMethod, shares } = validateShares(input, base, await activeMemberSet(planId, conn));
    await conn.query(
      `INSERT INTO expenses (id, plan_id, paid_on, payer_user_id, category, title, amount_minor,
         currency, fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url, created_by_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, planId, paidOnOrNull(input.paid_on), input.payer_user_id,
        CATEGORIES.has(String(input.category)) ? input.category : "other",
        String(input.title || "").slice(0, 200), amount,
        String(input.currency || "JPY").toUpperCase().slice(0, 3), rate, base,
        splitMethod,
        PAY.has(String(input.payment_method)) ? input.payment_method : null,
        input.note || null, safeUrl(input.receipt_url), actorUserId || null,
      ],
    );
    await insertShares(conn, id, shares);
    await recordExpenseAudit(conn, {
      planId,
      expenseId: id,
      actorUserId,
      action: "create",
      before: null,
      after: await expenseSnapshot(conn, id),
    });
  });
  return { id };
}

async function insertShares(
  conn: mysql.PoolConnection,
  expenseId: string,
  shares: { user_id: string; amount_base_minor: number }[],
): Promise<void> {
  const rows = (shares || [])
    .filter((s) => s && s.user_id && Number(s.amount_base_minor) > 0)
    .map((s) => [expenseId, s.user_id, Math.round(Number(s.amount_base_minor))]);
  if (rows.length) {
    await conn.query("INSERT INTO expense_shares (expense_id, user_id, amount_base_minor) VALUES ?", [rows]);
  }
}

async function expenseSnapshot(conn: mysql.PoolConnection, expenseId: string): Promise<Record<string, unknown> | null> {
  const [rows] = await conn.query<Row[]>(
    `SELECT id, plan_id, paid_on, payer_user_id, category, title, amount_minor, currency,
            fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url,
            created_by_id, created_at, updated_at, deleted_at
       FROM expenses WHERE id = ? LIMIT 1`,
    [expenseId],
  );
  const expense = (rows as unknown as Record<string, unknown>[])[0];
  if (!expense) return null;
  const [shareRows] = await conn.query<Row[]>(
    "SELECT user_id, amount_base_minor FROM expense_shares WHERE expense_id = ? ORDER BY user_id",
    [expenseId],
  );
  return { ...expense, shares: shareRows as unknown as Record<string, unknown>[] };
}

async function recordExpenseAudit(
  conn: mysql.PoolConnection,
  input: {
    planId: string;
    expenseId: string;
    actorUserId: string;
    action: "create" | "update" | "delete" | "restore";
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<void> {
  await conn.query(
    `INSERT INTO expense_audit_logs
       (id, plan_id, expense_id, actor_user_id, action, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId("aud"), input.planId, input.expenseId, input.actorUserId || null, input.action,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
    ],
  );
}

export async function listExpenseAudit(planId: string): Promise<Record<string, unknown>[]> {
  return all(
    `SELECT id, plan_id, expense_id, actor_user_id, action, before_json, after_json, created_at
       FROM expense_audit_logs WHERE plan_id = ? ORDER BY created_at DESC LIMIT 500`,
    [planId],
  );
}

export async function updateExpense(id: string, input: ExpenseInput, actorUserId: string): Promise<void> {
  const { amount, rate, base } = computeAmounts(input);
  await withTransaction(async (conn) => {
    const planId = (await firstRow<{ plan_id: string }>(
      conn, "SELECT plan_id FROM expenses WHERE id = ?", [id],
    ))?.plan_id;
    if (!planId) throw new NotFound("費用が見つかりません");
    await assertWorkspaceEditor(conn, planId, actorUserId);
    const locked = await firstRow<{ id: string }>(
      conn, "SELECT id FROM expenses WHERE id = ? AND plan_id = ? LIMIT 1 FOR UPDATE", [id, planId],
    );
    if (!locked) throw new NotFound("費用が見つかりません");
    const before = await expenseSnapshot(conn, id);
    const { splitMethod, shares } = validateShares(input, base, await activeMemberSet(planId, conn));
    await conn.query(
      `UPDATE expenses SET paid_on = ?, payer_user_id = ?, category = ?, title = ?, amount_minor = ?,
         currency = ?, fx_rate = ?, amount_base_minor = ?, split_method = ?, payment_method = ?,
         note = ?, receipt_url = ? WHERE id = ?`,
      [
        paidOnOrNull(input.paid_on), input.payer_user_id,
        CATEGORIES.has(String(input.category)) ? input.category : "other",
        String(input.title || "").slice(0, 200), amount,
        String(input.currency || "JPY").toUpperCase().slice(0, 3), rate, base,
        splitMethod,
        PAY.has(String(input.payment_method)) ? input.payment_method : null,
        input.note || null, safeUrl(input.receipt_url), id,
      ],
    );
    await conn.query("DELETE FROM expense_shares WHERE expense_id = ?", [id]);
    await insertShares(conn, id, shares);
    await recordExpenseAudit(conn, {
      planId,
      expenseId: id,
      actorUserId,
      action: "update",
      before,
      after: await expenseSnapshot(conn, id),
    });
  });
}

/** 論理削除（UI に「元に戻す」があるため物理削除しない）。 */
export async function deleteExpense(id: string, actorUserId: string): Promise<void> {
  await setExpenseDeleted(id, actorUserId, true);
}

export async function restoreExpense(id: string, actorUserId: string): Promise<void> {
  await setExpenseDeleted(id, actorUserId, false);
}

async function setExpenseDeleted(id: string, actorUserId: string, deleted: boolean): Promise<void> {
  await withTransaction(async (conn) => {
    const planId = (await firstRow<{ plan_id: string }>(
      conn, "SELECT plan_id FROM expenses WHERE id = ?", [id],
    ))?.plan_id;
    if (!planId) throw new NotFound("費用が見つかりません");
    await assertWorkspaceEditor(conn, planId, actorUserId);
    const locked = await firstRow<{ id: string }>(
      conn, "SELECT id FROM expenses WHERE id = ? AND plan_id = ? LIMIT 1 FOR UPDATE", [id, planId],
    );
    if (!locked) throw new NotFound("費用が見つかりません");
    const before = await expenseSnapshot(conn, id);
    await conn.query(
      deleted
        ? "UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?"
        : "UPDATE expenses SET deleted_at = NULL WHERE id = ?",
      [id],
    );
    await recordExpenseAudit(conn, {
      planId,
      expenseId: id,
      actorUserId,
      action: deleted ? "delete" : "restore",
      before,
      after: await expenseSnapshot(conn, id),
    });
  });
}

export async function createSettlement(planId: string, input: {
  from_user_id: string; to_user_id: string; amount_base_minor: number; note?: string | null;
}, actorUserId: string): Promise<{ id: string }> {
  const amount = Math.round(Number(input.amount_base_minor) || 0);
  if (amount <= 0) throw new BadRequest("精算額は1以上にしてください");
  if (input.from_user_id === input.to_user_id) throw new BadRequest("送金元と送金先は別の参加者にしてください");
  const id = newId("stl");
  await withTransaction(async (conn) => {
    await assertWorkspaceEditor(conn, planId, actorUserId);
    const memberIds = await activeMemberSet(planId, conn);
    assertMember(memberIds, String(input.from_user_id || ""), "送金元");
    assertMember(memberIds, String(input.to_user_id || ""), "送金先");
    assertMember(memberIds, actorUserId, "記録者");
    await conn.query(
      `INSERT INTO settlements (id, plan_id, from_user_id, to_user_id, amount_base_minor, note, created_by_id)
       VALUES (?,?,?,?,?,?,?)`,
      [id, planId, input.from_user_id, input.to_user_id, amount, input.note || null, actorUserId],
    );
  });
  return { id };
}

/** 誤って付けた精算完了を取り消す。行は監査・復旧用に論理削除で残す。 */
export async function deleteSettlement(id: string, actorUserId: string): Promise<void> {
  await withTransaction(async (conn) => {
    const settlement = await firstRow<{ plan_id: string }>(
      conn, "SELECT plan_id FROM settlements WHERE id = ? AND deleted_at IS NULL LIMIT 1", [id],
    );
    if (!settlement) throw new NotFound("取消できる精算記録が見つかりません");
    await assertWorkspaceEditor(conn, settlement.plan_id, actorUserId);
    const locked = await firstRow<{ id: string }>(
      conn,
      "SELECT id FROM settlements WHERE id = ? AND plan_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [id, settlement.plan_id],
    );
    if (!locked) throw new NotFound("取消できる精算記録が見つかりません");
    const [result] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE settlements SET deleted_at = CURRENT_TIMESTAMP, deleted_by_id = ?
        WHERE id = ? AND deleted_at IS NULL`,
      [actorUserId, id],
    );
    if (result.affectedRows !== 1) throw new NotFound("取消できる精算記録が見つかりません");
  });
  console.info("[travel-api] settlement deleted", JSON.stringify({ id, actor_user_id: actorUserId }));
}
