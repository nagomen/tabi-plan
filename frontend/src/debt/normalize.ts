// API 応答を画面が前提にする形へ整える。古い API・手で直した DB 行・途中で切れた応答でも
// 描画中に TypeError で落ちないよう、ここで型をそろえ、必須部分が壊れていれば利用者向けのエラーにする。
import { DebtViewerError } from "./api";

export interface Installment {
  number: number;
  due_date: string;
  amount_yen: number;
  paid_at: string | null;
}

export interface BudgetItem {
  label: string;
  amount_yen: number;
}

export interface IncomePlan {
  hourly_wage_yen: number;
  monthly_hours_cap: number;
  gross_income_yen: number;
  estimated_net_income_yen: number;
  description: string;
  reduced_income_months: Array<{ label: string; net_income_yen: number; note: string }>;
}

export interface ExpensePlan {
  fixed_items: BudgetItem[];
  variable_items: BudgetItem[];
  fixed_total_yen: number;
  variable_total_yen: number;
  monthly_total_yen: number;
  special_expense_note: string;
}

export interface FundingPlan {
  monthly_available_yen: number;
  monthly_repayment_yen: number;
  monthly_buffer_yen: number;
  actions: string[];
}

export interface RepaymentScenario {
  id: string;
  title: string;
  net_income_yen: number;
  monthly_expenses_yen: number;
  monthly_repayment_yen: number;
  monthly_buffer_yen: number;
  completion_date: string;
  note: string;
  schedule: Array<{ due_date: string; amount_yen: number }>;
}

export interface DebtDocument {
  submitted_on: string;
  monthly_income_yen: number;
  existing_debts: Array<{ creditor: string; amount_yen: number }>;
  difference_note: string;
  income_plan?: IncomePlan;
  expense_plan?: ExpensePlan;
  funding_plan?: FundingPlan;
  repayment_scenarios: RepaymentScenario[];
  promises: Array<{ title: string; body: string }>;
  collateral_note: string;
  gambling_pledge: string;
  closing_note: string;
}

export interface DebtPlan {
  borrower_name: string;
  creditor_name: string;
  principal_yen: number;
  interest_yen: number;
  total_yen: number;
  paid_yen: number;
  schedule: Installment[];
  document: DebtDocument;
  updated_at: string;
}

export interface DebtPdf {
  filename: string;
  mime_type: string;
  data_base64: string;
}

type Obj = Record<string, unknown>;

const DATE = /^\d{4}-\d{2}-\d{2}/;

function broken(): never {
  throw new DebtViewerError(
    "返済計画のデータが想定と異なる形式のため表示できません。送信者へお知らせください。",
    "返済計画のデータに問題があります",
  );
}

function obj(value: unknown): Obj | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function yen(value: unknown): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? Math.round(number) : 0;
}

function list<T>(value: unknown, map: (item: Obj, index: number) => T | undefined): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const record = obj(item);
    const mapped = record ? map(record, index) : undefined;
    return mapped === undefined ? [] : [mapped];
  });
}

function budget(value: unknown): BudgetItem[] {
  return list(value, (item) => ({ label: text(item.label), amount_yen: yen(item.amount_yen) }));
}

function incomePlan(value: unknown): IncomePlan | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  return {
    hourly_wage_yen: yen(raw.hourly_wage_yen),
    monthly_hours_cap: yen(raw.monthly_hours_cap),
    gross_income_yen: yen(raw.gross_income_yen),
    estimated_net_income_yen: yen(raw.estimated_net_income_yen),
    description: text(raw.description),
    reduced_income_months: list(raw.reduced_income_months, (item) => ({
      label: text(item.label), net_income_yen: yen(item.net_income_yen), note: text(item.note),
    })),
  };
}

function expensePlan(value: unknown): ExpensePlan | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  return {
    fixed_items: budget(raw.fixed_items),
    variable_items: budget(raw.variable_items),
    fixed_total_yen: yen(raw.fixed_total_yen),
    variable_total_yen: yen(raw.variable_total_yen),
    monthly_total_yen: yen(raw.monthly_total_yen),
    special_expense_note: text(raw.special_expense_note),
  };
}

function fundingPlan(value: unknown): FundingPlan | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  return {
    monthly_available_yen: yen(raw.monthly_available_yen),
    monthly_repayment_yen: yen(raw.monthly_repayment_yen),
    monthly_buffer_yen: yen(raw.monthly_buffer_yen),
    actions: Array.isArray(raw.actions) ? raw.actions.map(text).filter(Boolean) : [],
  };
}

function scenarios(value: unknown): RepaymentScenario[] {
  return list(value, (item, index) => ({
    id: text(item.id) || `scenario-${index + 1}`,
    title: text(item.title),
    net_income_yen: yen(item.net_income_yen),
    monthly_expenses_yen: yen(item.monthly_expenses_yen),
    monthly_repayment_yen: yen(item.monthly_repayment_yen),
    monthly_buffer_yen: yen(item.monthly_buffer_yen),
    completion_date: text(item.completion_date),
    note: text(item.note),
    schedule: list(item.schedule, (row) => {
      const due = text(row.due_date);
      return DATE.test(due) ? { due_date: due, amount_yen: yen(row.amount_yen) } : undefined;
    }),
  }));
}

function documentData(value: unknown): DebtDocument {
  const raw = obj(value) || {};
  return {
    submitted_on: text(raw.submitted_on),
    monthly_income_yen: yen(raw.monthly_income_yen),
    existing_debts: list(raw.existing_debts, (item) => ({ creditor: text(item.creditor), amount_yen: yen(item.amount_yen) })),
    difference_note: text(raw.difference_note),
    income_plan: incomePlan(raw.income_plan),
    expense_plan: expensePlan(raw.expense_plan),
    funding_plan: fundingPlan(raw.funding_plan),
    repayment_scenarios: scenarios(raw.repayment_scenarios),
    promises: list(raw.promises, (item) => ({ title: text(item.title), body: text(item.body) })),
    collateral_note: text(raw.collateral_note),
    gambling_pledge: text(raw.gambling_pledge),
    closing_note: text(raw.closing_note),
  };
}

/** 返済予定は進捗・次回期日・完済日の計算元なので、1件でも期日が読めなければ全体を表示しない。 */
function installments(value: unknown): Installment[] {
  if (!Array.isArray(value)) broken();
  const items = value.map((item, index) => {
    const raw = obj(item);
    const due = text(raw?.due_date);
    if (!raw || !DATE.test(due)) broken();
    const paidAt = text(raw.paid_at);
    return {
      number: Number.isInteger(raw.number) ? Number(raw.number) : index + 1,
      due_date: due,
      amount_yen: Math.max(0, yen(raw.amount_yen)),
      paid_at: paidAt || null,
    };
  });
  // 表の累計・次回期日は期日順が前提。保存順が崩れていても並べ直す。
  return items.sort((a, b) => a.due_date.localeCompare(b.due_date));
}

export function normalizePlan(value: unknown): DebtPlan {
  const raw = obj(value);
  if (!raw) broken();
  return {
    borrower_name: text(raw.borrower_name),
    creditor_name: text(raw.creditor_name),
    principal_yen: Math.max(0, yen(raw.principal_yen)),
    interest_yen: Math.max(0, yen(raw.interest_yen)),
    total_yen: Math.max(0, yen(raw.total_yen)),
    paid_yen: Math.max(0, yen(raw.paid_yen)),
    schedule: installments(raw.schedule),
    document: documentData(raw.document),
    updated_at: text(raw.updated_at),
  };
}

export function normalizePdf(value: unknown): DebtPdf {
  const raw = obj(value);
  const data = text(raw?.data_base64).replace(/\s+/g, "");
  if (!raw || !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new DebtViewerError(
      "原本PDFを受け取れませんでした。しばらくしてからもう一度お試しください。",
      "PDFを取得できませんでした",
      true,
    );
  }
  // 保存ダイアログで弾かれる文字と制御文字を落とす。
  const filename = Array.from(text(raw.filename)).filter((character) => character >= " ").join("")
    .replace(/[\\/:*?"<>|]/g, "_").trim();
  return {
    filename: filename || "repayment-plan.pdf",
    mime_type: text(raw.mime_type) || "application/pdf",
    data_base64: data,
  };
}
