import { all, firstRow, pool } from "./db.js";
import { Forbidden, NotFound } from "./errors.js";
import * as expenseRepo from "./expense-repo.js";
import { TARGET_TRIP_SLUG } from "./mcp-constants.js";

export interface McpExpenseMember {
  id: string;
  display_name: string;
  status: string;
}

export interface McpExpenseRow {
  id: string;
  paid_on: string | null;
  payer_user_id: string;
  category: string;
  title: string;
  amount_minor: number;
  currency: string;
  fx_rate: number;
  amount_base_minor: number;
  split_method: string;
  payment_method: string | null;
  note: string | null;
  receipt_url: string | null;
  updated_at: string;
  deleted_at: string | null;
  shares: { user_id: string; amount_base_minor: number }[];
}

export interface McpExpenseData {
  plan: { id: string; title: string; base_currency: string; updated_at: string };
  members: McpExpenseMember[];
  expenses: McpExpenseRow[];
}

async function targetPlanForEditor(actorUserId: string): Promise<McpExpenseData["plan"]> {
  const plan = await firstRow<McpExpenseData["plan"]>(pool,
    `SELECT p.id, p.title, p.base_currency, p.updated_at
       FROM plans p JOIN plan_access_grants pag
         ON pag.plan_id = p.id AND pag.user_id = ?
      WHERE p.slug = ? AND p.deleted_at IS NULL AND p.source <> 'sample'
        AND pag.status = 'active' AND pag.role IN ('owner','editor') LIMIT 1`,
    [actorUserId, TARGET_TRIP_SLUG],
  );
  if (!plan) throw new Forbidden("この旅行の費用を編集する権限がありません");
  return plan;
}

export async function loadTargetTripExpenses(actorUserId: string, includeDeleted = false): Promise<McpExpenseData> {
  const plan = await targetPlanForEditor(actorUserId);
  const [members, expenses, shares] = await Promise.all([
    all<McpExpenseMember>(
      `SELECT pm.user_id AS id, pm.display_name, pm.status
         FROM plan_members pm WHERE pm.plan_id = ? ORDER BY pm.joined_at, pm.user_id`,
      [plan.id],
    ),
    all<Omit<McpExpenseRow, "shares">>(
      `SELECT id, paid_on, payer_user_id, category, title, amount_minor, currency,
              fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url,
              updated_at, deleted_at
         FROM expenses WHERE plan_id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}
        ORDER BY paid_on DESC, created_at DESC`,
      [plan.id],
    ),
    all<{ expense_id: string; user_id: string; amount_base_minor: number }>(
      `SELECT s.expense_id, s.user_id, s.amount_base_minor
         FROM expense_shares s JOIN expenses e ON e.id = s.expense_id
        WHERE e.plan_id = ?`,
      [plan.id],
    ),
  ]);
  const byExpense = new Map<string, { user_id: string; amount_base_minor: number }[]>();
  for (const share of shares) {
    const list = byExpense.get(share.expense_id) || [];
    list.push({ user_id: share.user_id, amount_base_minor: Number(share.amount_base_minor) });
    byExpense.set(share.expense_id, list);
  }
  return {
    plan,
    members,
    expenses: expenses.map((expense) => ({
      ...expense,
      amount_minor: Number(expense.amount_minor),
      fx_rate: Number(expense.fx_rate),
      amount_base_minor: Number(expense.amount_base_minor),
      shares: byExpense.get(expense.id) || [],
    })),
  };
}

export async function createTargetExpense(
  actorUserId: string,
  input: expenseRepo.ExpenseInput,
  requestId: string,
): Promise<{ id: string; replayed: boolean }> {
  const plan = await targetPlanForEditor(actorUserId);
  return expenseRepo.createExpenseIdempotent(plan.id, input, actorUserId, requestId);
}

async function targetExpense(actorUserId: string, expenseId: string): Promise<McpExpenseRow> {
  const data = await loadTargetTripExpenses(actorUserId, true);
  const expense = data.expenses.find((item) => item.id === expenseId);
  if (!expense) throw new NotFound("この旅行の費用が見つかりません");
  return expense;
}

export type ExpensePatch = Partial<Omit<expenseRepo.ExpenseInput, "shares">> & {
  shares?: expenseRepo.ExpenseInput["shares"];
};

export async function updateTargetExpense(
  actorUserId: string,
  expenseId: string,
  patch: ExpensePatch,
): Promise<void> {
  const current = await targetExpense(actorUserId, expenseId);
  if (current.deleted_at) throw new Forbidden("削除済みの費用は、先に元へ戻してください");
  const input: expenseRepo.ExpenseInput = {
    paid_on: patch.paid_on !== undefined ? patch.paid_on : current.paid_on,
    payer_user_id: patch.payer_user_id !== undefined ? patch.payer_user_id : current.payer_user_id,
    category: patch.category !== undefined ? patch.category : current.category,
    title: patch.title !== undefined ? patch.title : current.title,
    amount_minor: patch.amount_minor !== undefined ? patch.amount_minor : current.amount_minor,
    currency: patch.currency !== undefined ? patch.currency : current.currency,
    fx_rate: patch.fx_rate !== undefined ? patch.fx_rate : current.fx_rate,
    split_method: patch.split_method !== undefined ? patch.split_method : current.split_method,
    payment_method: patch.payment_method !== undefined ? patch.payment_method : current.payment_method,
    note: patch.note !== undefined ? patch.note : current.note,
    receipt_url: patch.receipt_url !== undefined ? patch.receipt_url : current.receipt_url,
    shares: patch.shares !== undefined ? patch.shares : current.shares,
  };
  await expenseRepo.updateExpense(expenseId, input, actorUserId);
}

export async function deleteTargetExpense(actorUserId: string, expenseId: string): Promise<void> {
  const current = await targetExpense(actorUserId, expenseId);
  if (current.deleted_at) return;
  await expenseRepo.deleteExpense(expenseId, actorUserId);
}

export async function restoreTargetExpense(actorUserId: string, expenseId: string): Promise<void> {
  const current = await targetExpense(actorUserId, expenseId);
  if (!current.deleted_at) return;
  await expenseRepo.restoreExpense(expenseId, actorUserId);
}
