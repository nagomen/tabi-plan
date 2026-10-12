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

export interface ExpenseGroup {
  label: string;
  items: BudgetItem[];
  subtotal_yen: number;
  deduction_items: BudgetItem[];
  total_yen: number;
}

export interface IncomePlan {
  hourly_wage_yen: number;
  monthly_hours_min: number;
  monthly_hours_cap: number;
  gross_income_min_yen: number;
  gross_income_yen: number;
  estimated_net_income_min_yen: number;
  estimated_net_income_yen: number;
  description: string;
  reduced_income_months: Array<{ label: string; net_income_yen: number; note: string }>;
}

export interface ExpensePlan {
  fixed_items: BudgetItem[];
  variable_items: BudgetItem[];
  living_cost_group?: ExpenseGroup;
  fixed_total_yen: number;
  variable_total_yen: number;
  monthly_total_yen: number;
  special_expense_note: string;
}

export interface FundingPlan {
  monthly_available_min_yen: number;
  monthly_available_yen: number;
  monthly_repayment_yen: number;
  monthly_buffer_min_yen: number;
  monthly_buffer_yen: number;
  actions: string[];
}

export interface RepaymentScenario {
  id: string;
  title: string;
  net_income_min_yen: number;
  net_income_yen: number;
  monthly_expenses_yen: number;
  monthly_repayment_yen: number;
  repayment_summary: string;
  monthly_buffer_min_yen: number;
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
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

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

function publicText(value: unknown, privateNames: Array<[string, string]>): string {
  let result = text(value).replace(EMAIL, "［非公開］");
  for (const [name, replacement] of privateNames) {
    if (name) result = result.split(name).join(replacement);
  }
  return result;
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

function budget(value: unknown, privateNames: Array<[string, string]>): BudgetItem[] {
  return list(value, (item) => ({ label: publicText(item.label, privateNames), amount_yen: yen(item.amount_yen) }));
}

function incomePlan(value: unknown, privateNames: Array<[string, string]>): IncomePlan | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const monthlyHoursCap = yen(raw.monthly_hours_cap);
  const grossIncome = yen(raw.gross_income_yen);
  const estimatedNetIncome = yen(raw.estimated_net_income_yen);
  return {
    hourly_wage_yen: yen(raw.hourly_wage_yen),
    monthly_hours_min: raw.monthly_hours_min === undefined ? monthlyHoursCap : yen(raw.monthly_hours_min),
    monthly_hours_cap: monthlyHoursCap,
    gross_income_min_yen: raw.gross_income_min_yen === undefined ? grossIncome : yen(raw.gross_income_min_yen),
    gross_income_yen: grossIncome,
    estimated_net_income_min_yen: raw.estimated_net_income_min_yen === undefined ? estimatedNetIncome : yen(raw.estimated_net_income_min_yen),
    estimated_net_income_yen: estimatedNetIncome,
    description: publicText(raw.description, privateNames),
    reduced_income_months: list(raw.reduced_income_months, (item) => ({
      label: publicText(item.label, privateNames), net_income_yen: yen(item.net_income_yen), note: publicText(item.note, privateNames),
    })),
  };
}

function expensePlan(value: unknown, privateNames: Array<[string, string]>): ExpensePlan | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const living = obj(raw.living_cost_group);
  return {
    fixed_items: budget(raw.fixed_items, privateNames),
    variable_items: budget(raw.variable_items, privateNames),
    living_cost_group: living ? {
      label: publicText(living.label, privateNames),
      items: budget(living.items, privateNames),
      subtotal_yen: yen(living.subtotal_yen),
      deduction_items: budget(living.deduction_items, privateNames),
      total_yen: yen(living.total_yen),
    } : undefined,
    fixed_total_yen: yen(raw.fixed_total_yen),
    variable_total_yen: yen(raw.variable_total_yen),
    monthly_total_yen: yen(raw.monthly_total_yen),
    special_expense_note: publicText(raw.special_expense_note, privateNames),
  };
}

function fundingPlan(value: unknown, privateNames: Array<[string, string]>): FundingPlan | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const monthlyAvailable = yen(raw.monthly_available_yen);
  const monthlyBuffer = yen(raw.monthly_buffer_yen);
  return {
    monthly_available_min_yen: raw.monthly_available_min_yen === undefined ? monthlyAvailable : yen(raw.monthly_available_min_yen),
    monthly_available_yen: monthlyAvailable,
    monthly_repayment_yen: yen(raw.monthly_repayment_yen),
    monthly_buffer_min_yen: raw.monthly_buffer_min_yen === undefined ? monthlyBuffer : yen(raw.monthly_buffer_min_yen),
    monthly_buffer_yen: monthlyBuffer,
    actions: Array.isArray(raw.actions) ? raw.actions.map((item) => publicText(item, privateNames)).filter(Boolean) : [],
  };
}

function scenarios(value: unknown, privateNames: Array<[string, string]>): RepaymentScenario[] {
  return list(value, (item, index) => {
    const netIncome = yen(item.net_income_yen);
    const monthlyBuffer = yen(item.monthly_buffer_yen);
    return {
      id: text(item.id) || `scenario-${index + 1}`,
      title: publicText(item.title, privateNames),
      net_income_min_yen: item.net_income_min_yen === undefined ? netIncome : yen(item.net_income_min_yen),
      net_income_yen: netIncome,
      monthly_expenses_yen: yen(item.monthly_expenses_yen),
      monthly_repayment_yen: yen(item.monthly_repayment_yen),
      repayment_summary: publicText(item.repayment_summary, privateNames),
      monthly_buffer_min_yen: item.monthly_buffer_min_yen === undefined ? monthlyBuffer : yen(item.monthly_buffer_min_yen),
      monthly_buffer_yen: monthlyBuffer,
      completion_date: text(item.completion_date),
      note: publicText(item.note, privateNames),
      schedule: list(item.schedule, (row) => {
        const due = text(row.due_date);
        return DATE.test(due) ? { due_date: due, amount_yen: yen(row.amount_yen) } : undefined;
      }),
    };
  });
}

function documentData(value: unknown, privateNames: Array<[string, string]>): DebtDocument {
  const raw = obj(value) || {};
  return {
    submitted_on: text(raw.submitted_on),
    monthly_income_yen: yen(raw.monthly_income_yen),
    existing_debts: list(raw.existing_debts, (item, index) => ({ creditor: `既存債務 ${index + 1}`, amount_yen: yen(item.amount_yen) })),
    difference_note: publicText(raw.difference_note, privateNames),
    income_plan: incomePlan(raw.income_plan, privateNames),
    expense_plan: expensePlan(raw.expense_plan, privateNames),
    funding_plan: fundingPlan(raw.funding_plan, privateNames),
    repayment_scenarios: scenarios(raw.repayment_scenarios, privateNames),
    promises: list(raw.promises, (item) => ({ title: publicText(item.title, privateNames), body: publicText(item.body, privateNames) })),
    collateral_note: publicText(raw.collateral_note, privateNames),
    gambling_pledge: publicText(raw.gambling_pledge, privateNames),
    closing_note: publicText(raw.closing_note, privateNames),
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
  const borrowerName = text(raw.borrower_name);
  const creditorName = text(raw.creditor_name);
  const privateNames: Array<[string, string]> = [[borrowerName, "借主"], [creditorName, "貸主"]];
  return {
    borrower_name: "",
    creditor_name: "",
    principal_yen: Math.max(0, yen(raw.principal_yen)),
    interest_yen: Math.max(0, yen(raw.interest_yen)),
    total_yen: Math.max(0, yen(raw.total_yen)),
    paid_yen: Math.max(0, yen(raw.paid_yen)),
    schedule: installments(raw.schedule),
    document: documentData(raw.document, privateNames),
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
