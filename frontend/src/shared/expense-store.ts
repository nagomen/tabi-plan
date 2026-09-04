// 費用のドメイン層。永続化は db.ts（MySQL の expenses / expense_shares / settlements）。
//
// 旧実装との違い:
//   - 人を user_id で参照する（旧: 表示名の文字列。改名で全部壊れていた）
//   - 1件=1行なので追加は INSERT。複数端末で同時に足しても消えない
//     （旧: 1旅行=1キーの配列を丸ごと PUT していたため後勝ちで消えた）
//   - 割り勘方式は SplitMethod の列挙（旧: 日本語文字列を正規表現で判定）
//   - 負担額は expense_shares が正。等分の端数もここで確定させ、合計＝支払額にする
//   - 精算は settlements（旧: kind='settlement' で費用に同居し targets[0] を受取人に流用）
//
// computeSettlement は純関数のまま。表示のために id → 表示名へ解決する
// （名前は「表示のための値」に降格した、という整理）。

import type { Settlement, SettlementTransfer, ExpenseDetail, SettlementHistory } from "./types";
import * as db from "./db";
import type {
  ExpenseRow, ExpenseShareRow, SettlementRow, SplitMethod, ExpenseCategory, PaymentMethod,
} from "./db";

export type { ExpenseRow, ExpenseShareRow, SplitMethod, ExpenseCategory, PaymentMethod };

/** 画面が扱う1件（費用 + 誰がいくら負担するか）。 */
export interface ExpenseEntry {
  row: ExpenseRow;
  shares: ExpenseShareRow[];
}

// ---- 表示ラベルと列挙の対応（UI の日本語はここだけに置く） ---------------

export const CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  food: "食費", transport: "交通", lodging: "宿泊",
  sightseeing: "観光", communication: "通信", other: "その他",
};

export const SPLIT_LABEL: Record<SplitMethod, string> = {
  equal_all: "全員で等分", equal_selected: "選んだ人だけで等分",
  custom: "個別金額を入力", none: "精算不要",
};

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  card: "カード", cash: "現金", transfer: "送金", other: "その他",
};

export const CATEGORIES = Object.keys(CATEGORY_LABEL) as ExpenseCategory[];
export const SPLIT_METHODS = Object.keys(SPLIT_LABEL) as SplitMethod[];
export const PAYMENT_METHODS = Object.keys(PAYMENT_LABEL) as PaymentMethod[];

// ---- 読み取り -----------------------------------------------------------

export function list(planId: string): ExpenseEntry[] {
  const shares = db.expenseShares();
  return db
    .expenses()
    .filter((e) => e.plan_id === planId && !e.deleted_at)
    .map((row) => ({ row, shares: shares.filter((s) => s.expense_id === row.id) }));
}

export function canceledList(planId: string): ExpenseEntry[] {
  const shares = db.expenseShares();
  return db
    .expenses()
    .filter((e) => e.plan_id === planId && e.deleted_at)
    .map((row) => ({ row, shares: shares.filter((s) => s.expense_id === row.id) }))
    .sort((a, b) => String(b.row.deleted_at || "").localeCompare(String(a.row.deleted_at || "")));
}

export function get(planId: string, expenseId: string): ExpenseEntry | undefined {
  return list(planId).find((e) => e.row.id === expenseId);
}

export function settlementsOf(planId: string): SettlementRow[] {
  return db.settlements().filter((s) => s.plan_id === planId);
}

// ---- 負担額の計算 -------------------------------------------------------

/**
 * 分割方式から負担額を確定させる。
 * 等分の端数は先頭の人から1単位ずつ寄せ、合計を支払額に必ず一致させる
 * （旧実装は割り切れない額を小数のまま持ち回っていた）。
 */
export function computeShares(input: {
  amountBaseMinor: number;
  splitMethod: SplitMethod;
  memberIds: string[];
  selectedIds?: string[];
  customAmounts?: Record<string, number>;
}): { user_id: string; amount_base_minor: number }[] {
  const amount = Math.round(input.amountBaseMinor) || 0;
  if (input.splitMethod === "none" || amount <= 0) return [];

  if (input.splitMethod === "custom") {
    return Object.entries(input.customAmounts || {})
      .map(([user_id, v]) => ({ user_id, amount_base_minor: Math.round(Number(v) || 0) }))
      .filter((s) => s.user_id && s.amount_base_minor > 0);
  }

  const pool =
    input.splitMethod === "equal_selected" && (input.selectedIds || []).length
      ? input.selectedIds || []
      : input.memberIds;
  const uniq = [...new Set(pool.filter(Boolean))];
  if (!uniq.length) return [];
  const base = Math.floor(amount / uniq.length);
  const rest = amount - base * uniq.length;
  return uniq.map((user_id, i) => ({ user_id, amount_base_minor: base + (i < rest ? 1 : 0) }));
}

// ---- 書き込み -----------------------------------------------------------

export interface AddInput {
  paidOn?: string | null;
  payerUserId: string;
  category?: ExpenseCategory;
  title?: string;
  amountMinor: number;
  currency?: string;
  fxRate?: number;
  splitMethod?: SplitMethod;
  paymentMethod?: PaymentMethod | null;
  note?: string | null;
  receiptUrl?: string | null;
  /** 等分の母集団（計画の参加者） */
  memberIds: string[];
  /** 「選んだ人だけ」のときの対象 */
  selectedIds?: string[];
  /** 「個別金額」のときの user_id → 金額 */
  customAmounts?: Record<string, number>;
}

function toApiInput(input: AddInput): db.ExpenseInput {
  const rate = input.fxRate && input.fxRate > 0 ? input.fxRate : 1;
  const amountBase = Math.round((Math.round(input.amountMinor) || 0) * rate);
  return {
    paid_on: input.paidOn ?? null,
    payer_user_id: input.payerUserId,
    category: input.category || "other",
    title: input.title || "",
    amount_minor: Math.round(input.amountMinor) || 0,
    currency: (input.currency || "JPY").toUpperCase(),
    fx_rate: rate,
    split_method: input.splitMethod || "equal_all",
    payment_method: input.paymentMethod ?? null,
    note: input.note ?? null,
    receipt_url: input.receiptUrl ?? null,
    shares: computeShares({
      amountBaseMinor: amountBase,
      splitMethod: input.splitMethod || "equal_all",
      memberIds: input.memberIds,
      selectedIds: input.selectedIds,
      customAmounts: input.customAmounts,
    }),
  };
}

export function add(planId: string, input: AddInput): Promise<ExpenseRow> {
  return db.addExpense(planId, toApiInput(input));
}

export function update(expenseId: string, input: AddInput): Promise<void> {
  return db.updateExpense(expenseId, toApiInput(input));
}

export function remove(expenseId: string): { row: ExpenseRow | undefined; shares: ExpenseShareRow[] } {
  return db.removeExpense(expenseId);
}

export function restore(row: ExpenseRow, shares: ExpenseShareRow[]): void {
  db.restoreExpense(row, shares);
}

export function restoreById(planId: string, expenseId: string): boolean {
  const entry = canceledList(planId).find((item) => item.row.id === expenseId);
  if (!entry) return false;
  restore(entry.row, entry.shares);
  return true;
}

export function addSettlement(planId: string, input: {
  fromUserId: string; toUserId: string; amountBaseMinor: number; note?: string | null;
}): Promise<void> {
  return db.addSettlement(planId, {
    from_user_id: input.fromUserId,
    to_user_id: input.toUserId,
    amount_base_minor: Math.round(input.amountBaseMinor),
    note: input.note ?? null,
  });
}

export function removeSettlement(settlementId: string): Promise<void> {
  return db.removeSettlement(settlementId);
}

// ---- 金額表示ヘルパー ---------------------------------------------------

function formatYen(value: number): string {
  return value ? "¥" + Math.round(value).toLocaleString("ja-JP") : "¥0";
}

function amountLabel(row: ExpenseRow): string {
  const currency = (row.currency || "JPY").toUpperCase();
  if (currency !== "JPY") return `${currency} ${row.amount_minor.toLocaleString("ja-JP")}`;
  return formatYen(row.amount_minor);
}

export function entryDetail(entry: ExpenseEntry, selfUserId = ""): ExpenseDetail {
  const { row, shares } = entry;
  const mine = selfUserId ? shares.find((s) => s.user_id === selfUserId) : undefined;
  return {
    id: row.id,
    kind: "expense",
    date: row.paid_on || "",
    payer: db.nameOf(row.payer_user_id),
    category: CATEGORY_LABEL[row.category] || "その他",
    title: row.title || "立替",
    mode: SPLIT_LABEL[row.split_method] || "",
    amountLabel: amountLabel(row),
    convertedLabel: formatYen(row.amount_base_minor),
    myShareLabel: selfUserId ? formatYen(mine ? mine.amount_base_minor : 0) : "",
    targetNames: shares.map((s) => db.nameOf(s.user_id)),
    shares: shares.map((s) => ({
      name: db.nameOf(s.user_id),
      amount: s.amount_base_minor,
      amountLabel: formatYen(s.amount_base_minor),
    })),
  };
}

// ---- 精算計算（純関数） -------------------------------------------------

/** ネット残高（立替 - 負担）から、誰→誰の振込が必要かを貪欲法で求める。 */
function settleTransfers(net: Record<string, number>): { fromId: string; toId: string; amount: number }[] {
  const creditors = Object.entries(net).filter(([, v]) => v > 0).map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v);
  const debtors = Object.entries(net).filter(([, v]) => v < 0).map(([id, v]) => ({ id, v: -v })).sort((a, b) => b.v - a.v);
  const out: { fromId: string; toId: string; amount: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    if (pay > 0) out.push({ fromId: debtors[i].id, toId: creditors[j].id, amount: pay });
    debtors[i].v -= pay;
    creditors[j].v -= pay;
    if (debtors[i].v <= 0) i += 1;
    if (creditors[j].v <= 0) j += 1;
  }
  return out;
}

/**
 * 計画の費用・負担・精算から、ダッシュボードが描画する Settlement を組み立てる。
 * 表示のため id を表示名へ解決する。
 */
export function computeSettlement(
  planId: string,
  memberIds: string[],
  selfUserId: string,
  baseCurrency = "JPY",
): Settlement {
  const entries = list(planId);
  const paid: Record<string, number> = {};
  const owe: Record<string, number> = {};
  const bump = (map: Record<string, number>, id: string, v: number): void => {
    if (!id) return;
    map[id] = (map[id] || 0) + v;
  };
  memberIds.forEach((id) => {
    paid[id] = paid[id] || 0;
    owe[id] = owe[id] || 0;
  });

  const details: ExpenseDetail[] = [];
  const settlementHistory: SettlementHistory[] = [];
  let total = 0;

  for (const { row, shares } of entries) {
    total += row.amount_base_minor;
    bump(paid, row.payer_user_id, row.amount_base_minor);
    for (const s of shares) bump(owe, s.user_id, s.amount_base_minor);

    details.push(entryDetail({ row, shares }, selfUserId));
  }

  // 精算済みの送金: 払った側の立替を増やし、受け取った側の負担を増やす（相殺）
  for (const s of settlementsOf(planId)) {
    bump(paid, s.from_user_id, s.amount_base_minor);
    bump(owe, s.to_user_id, s.amount_base_minor);
    settlementHistory.push({
      id: s.id,
      date: (s.settled_at || "").slice(0, 10),
      from: db.nameOf(s.from_user_id),
      to: db.nameOf(s.to_user_id),
      amount: s.amount_base_minor,
      amountLabel: formatYen(s.amount_base_minor),
      note: s.note || "",
    });
  }

  const ids = [...new Set([...memberIds, ...Object.keys(paid), ...Object.keys(owe)])];
  const net: Record<string, number> = {};
  const expenseByPerson: Record<string, number> = {};
  for (const id of ids) {
    net[id] = (paid[id] || 0) - (owe[id] || 0);
    expenseByPerson[db.nameOf(id) || id] = Math.round(owe[id] || 0);
  }

  const transfers: SettlementTransfer[] = settleTransfers(net).map((t) => ({
    from: db.nameOf(t.fromId),
    to: db.nameOf(t.toId),
    fromId: t.fromId,
    toId: t.toId,
    amount: t.amount,
    amountLabel: formatYen(t.amount),
  }));

  const yourNet = selfUserId ? net[selfUserId] || 0 : 0;
  details.reverse(); // newest first
  settlementHistory.reverse(); // newest first

  return {
    expenseTotal: formatYen(total),
    expenseByPerson,
    yourPaid: selfUserId ? formatYen(paid[selfUserId] || 0) : "—",
    yourDue: selfUserId ? formatYen(Math.max(0, -yourNet)) : "¥0",
    transfers,
    settlementHistory,
    expenseDetails: details,
    baseCurrency,
  };
}
