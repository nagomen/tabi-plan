import { firstRow, pool } from "./db.js";
import { NotFound } from "./errors.js";
import { debtShareTokenHash, isDebtShareToken } from "./debt-share-token.js";

export interface DebtInstallment {
  number: number;
  due_date: string;
  amount_yen: number;
  paid_at: string | null;
}

export interface DebtDocument {
  submitted_on: string;
  monthly_income_yen: number;
  existing_debts: Array<{ creditor: string; amount_yen: number }>;
  difference_note: string;
  promises: Array<{ title: string; body: string }>;
  collateral_note: string;
  gambling_pledge: string;
  closing_note: string;
}

interface DebtRow {
  borrower_name: string;
  creditor_name: string;
  principal_yen: number;
  interest_yen: number;
  total_yen: number;
  paid_yen: number;
  schedule_json: string | DebtInstallment[];
  document_json: string | DebtDocument;
  updated_at: string;
}

function inaccessible(): never {
  // 存在・失効・形式不正を区別せず、共有リンクの状態を推測させない。
  throw new NotFound("この共有リンクは無効か、公開が終了しています。");
}

function parsed<T>(value: string | T): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

async function debtRow(token: string): Promise<DebtRow> {
  if (!isDebtShareToken(token)) inaccessible();
  const row = await firstRow<DebtRow>(
    pool,
    `SELECT p.borrower_name, p.creditor_name, p.principal_yen, p.interest_yen,
            p.total_yen, p.paid_yen, p.schedule_json, p.document_json, p.updated_at
       FROM debt_share_links l
       JOIN debt_plans p ON p.id = l.plan_id
      WHERE l.token_hash = ?
        AND l.revoked_at IS NULL
        AND (l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)
      LIMIT 1`,
    [debtShareTokenHash(token)],
  );
  if (!row) inaccessible();
  return row;
}

export async function loadSharedDebt(token: string): Promise<Record<string, unknown>> {
  const row = await debtRow(token);
  const schedule = parsed<DebtInstallment[]>(row.schedule_json);
  const document = parsed<DebtDocument>(row.document_json);
  return {
    borrower_name: row.borrower_name,
    creditor_name: row.creditor_name,
    principal_yen: Number(row.principal_yen),
    interest_yen: Number(row.interest_yen),
    total_yen: Number(row.total_yen),
    paid_yen: Number(row.paid_yen),
    schedule,
    document,
    updated_at: row.updated_at,
  };
}

export async function loadSharedDebtPdf(token: string): Promise<{
  filename: string;
  mime_type: "application/pdf";
  data_base64: string;
}> {
  if (!isDebtShareToken(token)) inaccessible();
  const row = await firstRow<{ document_pdf: Buffer; pdf_filename: string }>(
    pool,
    `SELECT p.document_pdf, p.pdf_filename
       FROM debt_share_links l
       JOIN debt_plans p ON p.id = l.plan_id
      WHERE l.token_hash = ?
        AND l.revoked_at IS NULL
        AND (l.expires_at IS NULL OR l.expires_at > CURRENT_TIMESTAMP)
      LIMIT 1`,
    [debtShareTokenHash(token)],
  );
  if (!row?.document_pdf?.length) inaccessible();
  return {
    filename: row.pdf_filename || "repayment-plan.pdf",
    mime_type: "application/pdf",
    data_base64: row.document_pdf.toString("base64"),
  };
}
