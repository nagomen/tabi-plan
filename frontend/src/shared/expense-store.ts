// 費用のローカル保存層（JSON / localStorage）。
// Apps Script(Web App) を使わない構成のときに、費用と精算を端末内 JSON で扱う。
// 将来 DB へ移行する際は、この list/add/remove の実装だけを差し替えればよい
// （computeSettlement は純関数なので DB 化しても再利用できる）。

import type { Settlement, SettlementTransfer, ExpenseDetail, SettlementShare } from "./types";
import * as Backend from "./backend";

/** 1件の費用 or 精算記録。kind で区別する。 */
export interface ExpenseRecord {
  id: string;
  /** "expense": 立替費用 / "settlement": 精算完了の振込記録 */
  kind: "expense" | "settlement";
  paidDate: string;
  payer: string;
  category: string;
  title: string;
  amount: number;
  currency: string;
  /** "全員で等分" | "選んだ人だけで等分" | "個別金額を入力" | "精算不要" */
  splitMode: string;
  /** 割り勘対象（選んだ人だけ）。settlement の場合は [受取人] */
  targets: string[];
  /** 個別金額（個別金額を入力） */
  individual: Record<string, number>;
  paymentMethod: string;
  note: string;
  receiptUrl?: string;
  createdAt: string;
}

const PREFIX = "trip-dashboard-expenses-";

function storageKey(slug: string): string {
  return PREFIX + (slug || "default");
}

function readAll(slug: string): ExpenseRecord[] {
  const parsed = Backend.getJSON<ExpenseRecord[]>(storageKey(slug), []);
  return Array.isArray(parsed) ? parsed : [];
}

function writeAll(slug: string, records: ExpenseRecord[]): void {
  Backend.setJSON(storageKey(slug), records);
}

function newId(): string {
  return "exp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---- CRUD（将来 DB 化する場合はここを差し替える） ----------------------

export function list(slug: string): ExpenseRecord[] {
  return readAll(slug);
}

export function add(slug: string, input: Partial<ExpenseRecord>): ExpenseRecord {
  const record: ExpenseRecord = {
    id: newId(),
    kind: input.kind || "expense",
    paidDate: input.paidDate || "",
    payer: input.payer || "",
    category: input.category || "",
    title: input.title || "",
    amount: Number(input.amount) || 0,
    currency: input.currency || "JPY",
    splitMode: input.splitMode || "全員で等分",
    targets: input.targets || [],
    individual: input.individual || {},
    paymentMethod: input.paymentMethod || "",
    note: input.note || "",
    receiptUrl: input.receiptUrl || "",
    createdAt: new Date().toISOString(),
  };
  const records = readAll(slug);
  records.push(record);
  writeAll(slug, records);
  return record;
}

export function remove(slug: string, id: string): void {
  writeAll(slug, readAll(slug).filter((r) => r.id !== id));
}

// ---- 金額表示ヘルパー ---------------------------------------------------

function formatYen(value: number): string {
  return value ? "¥" + Math.round(value).toLocaleString("ja-JP") : "¥0";
}

function amountLabel(record: ExpenseRecord): string {
  const currency = (record.currency || "JPY").toUpperCase();
  if (currency && currency !== "JPY") return `${currency} ${record.amount.toLocaleString("ja-JP")}`;
  return formatYen(record.amount);
}

// ---- 精算計算（純関数。DB 化後もそのまま使える） -----------------------

/** ネット残高（立替 - 負担）から、誰→誰の振込が必要かを貪欲法で求める。 */
function settleTransfers(net: Record<string, number>): SettlementTransfer[] {
  const creditors = Object.entries(net)
    .filter(([, v]) => v > 0.5)
    .map(([name, v]) => ({ name, v }))
    .sort((a, b) => b.v - a.v);
  const debtors = Object.entries(net)
    .filter(([, v]) => v < -0.5)
    .map(([name, v]) => ({ name, v: -v }))
    .sort((a, b) => b.v - a.v);
  const transfers: SettlementTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].v, creditors[j].v);
    if (pay > 0.5) {
      transfers.push({
        from: debtors[i].name,
        to: creditors[j].name,
        amount: Math.round(pay),
        amountLabel: formatYen(pay),
      });
    }
    debtors[i].v -= pay;
    creditors[j].v -= pay;
    if (debtors[i].v <= 0.5) i += 1;
    if (creditors[j].v <= 0.5) j += 1;
  }
  return transfers;
}

/** 費用記録 + 参加者から、ダッシュボードが描画する Settlement を組み立てる。 */
export function computeSettlement(
  records: ExpenseRecord[],
  participants: string[],
  profileName: string,
  baseCurrency = "JPY",
): Settlement {
  const paid: Record<string, number> = {}; // 立替（払った額）
  const owe: Record<string, number> = {}; // 負担（自分の取り分）
  participants.forEach((name) => {
    paid[name] = 0;
    owe[name] = 0;
  });
  const ensure = (map: Record<string, number>, name: string): void => {
    if (map[name] === undefined) map[name] = 0;
  };

  const details: ExpenseDetail[] = [];
  let total = 0;

  records.forEach((record) => {
    const amount = Number(record.amount) || 0;

    if (record.kind === "settlement") {
      // 精算完了: from が to に支払った → from の立替を増やし、to の負担を増やす（受取を相殺）
      const to = record.targets[0] || "";
      ensure(paid, record.payer);
      ensure(owe, to);
      paid[record.payer] += amount;
      owe[to] += amount;
      return;
    }

    total += amount;
    ensure(paid, record.payer);
    paid[record.payer] += amount;

    let shares: { name: string; amount: number }[] = [];
    if (/精算不要/.test(record.splitMode)) {
      shares = [];
    } else if (/個別金額/.test(record.splitMode)) {
      shares = Object.entries(record.individual || {})
        .map(([name, value]) => ({ name, amount: Number(value) || 0 }))
        .filter((share) => share.amount > 0);
    } else if (/選んだ人/.test(record.splitMode)) {
      const targets = record.targets && record.targets.length ? record.targets : participants;
      const each = targets.length ? amount / targets.length : 0;
      shares = targets.map((name) => ({ name, amount: each }));
    } else {
      const each = participants.length ? amount / participants.length : 0;
      shares = participants.map((name) => ({ name, amount: each }));
    }

    shares.forEach((share) => {
      ensure(owe, share.name);
      owe[share.name] += share.amount;
    });

    const myShare = profileName ? shares.find((share) => share.name === profileName) : undefined;
    const shareList: SettlementShare[] = shares.map((share) => ({
      name: share.name,
      amount: Math.round(share.amount),
      amountLabel: formatYen(share.amount),
    }));
    details.push({
      date: record.paidDate,
      payer: record.payer,
      category: record.category,
      title: record.title || "立替",
      mode: record.splitMode,
      amountLabel: amountLabel(record),
      convertedLabel: formatYen(amount),
      myShareLabel: profileName ? formatYen(myShare ? myShare.amount : 0) : "",
      targetNames: shares.map((share) => share.name),
      shares: shareList,
    });
  });

  const names = Array.from(new Set([...participants, ...Object.keys(paid), ...Object.keys(owe)]));
  const net: Record<string, number> = {};
  const expenseByPerson: Record<string, number> = {};
  names.forEach((name) => {
    net[name] = (paid[name] || 0) - (owe[name] || 0);
    expenseByPerson[name] = Math.round(owe[name] || 0);
  });

  const transfers = settleTransfers(net);
  const yourNet = profileName ? net[profileName] || 0 : 0;
  // newest first（明細の見やすさ）
  details.reverse();

  return {
    expenseTotal: formatYen(total),
    expenseByPerson,
    yourPaid: profileName ? formatYen(paid[profileName] || 0) : "—",
    yourDue: profileName ? formatYen(Math.max(0, -yourNet)) : "¥0",
    transfers,
    expenseDetails: details,
    baseCurrency,
  };
}
