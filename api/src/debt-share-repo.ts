import { firstRow, pool } from "./db.js";
import { DataIntegrityError, NotFound } from "./errors.js";
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

export interface DebtRow {
  borrower_name: string;
  creditor_name: string;
  principal_yen: number | string;
  interest_yen: number | string;
  total_yen: number | string;
  paid_yen: number | string;
  schedule_json: unknown;
  document_json: unknown;
  updated_at: Date | string | null;
}

const BROKEN_DATA = "返済計画のデータを読み取れませんでした。お手数ですが、問い合わせ番号を添えて送信者へお知らせください。";
const DATE = /^\d{4}-\d{2}-\d{2}/;

function inaccessible(): never {
  // 存在・失効・形式不正を区別せず、共有リンクの状態を推測させない。
  throw new NotFound("この共有リンクは無効か、公開が終了しています。");
}

function broken(detail: string): never {
  throw new DataIntegrityError(`${BROKEN_DATA}（${detail}）`);
}

/** JSON列は mysql2 の設定次第で文字列・Buffer・解析済みのどれでも届く。 */
function parsed(value: unknown, column: string): unknown {
  if (value === null || value === undefined) broken(`${column} が空です`);
  if (typeof value !== "string" && !Buffer.isBuffer(value)) return value;
  try {
    return JSON.parse(value.toString());
  } catch {
    return broken(`${column} がJSONではありません`);
  }
}

function amount(value: unknown, column: string): number {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number) || number < 0) broken(`${column} が不正な金額です`);
  return Math.round(number);
}

function schedule(value: unknown): DebtInstallment[] {
  const list = parsed(value, "schedule_json");
  if (!Array.isArray(list)) broken("schedule_json が配列ではありません");
  return list.map((raw, index) => {
    const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const dueDate = typeof item.due_date === "string" ? item.due_date : "";
    if (!DATE.test(dueDate)) broken(`返済予定${index + 1}件目の期日が不正です`);
    const paidAt = item.paid_at;
    return {
      number: Number.isInteger(item.number) ? Number(item.number) : index + 1,
      due_date: dueDate,
      amount_yen: amount(item.amount_yen, `返済予定${index + 1}件目`),
      paid_at: typeof paidAt === "string" && paidAt ? paidAt : null,
    };
  });
}

function documentObject(value: unknown): Record<string, unknown> {
  const document = parsed(value, "document_json");
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    broken("document_json がオブジェクトではありません");
  }
  return document as Record<string, unknown>;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function publicText(value: string, privateNames: Array<[string, string]>): string {
  let result = value.replace(EMAIL, "［非公開］");
  for (const [name, replacement] of privateNames) {
    if (name) result = result.split(name).join(replacement);
  }
  return result;
}

function publicValue(value: unknown, privateNames: Array<[string, string]>): unknown {
  if (typeof value === "string") return publicText(value, privateNames);
  if (Array.isArray(value)) return value.map((item) => publicValue(item, privateNames));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item, privateNames)]));
}

function publicDocument(value: unknown, privateNames: Array<[string, string]>): Record<string, unknown> {
  const document = publicValue(documentObject(value), privateNames) as Record<string, unknown>;
  if (Array.isArray(document.existing_debts)) {
    document.existing_debts = document.existing_debts.map((value, index) => {
      const debt = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      return { ...debt, creditor: `既存債務 ${index + 1}` };
    });
  }
  return document;
}

function isoTimestamp(value: DebtRow["updated_at"]): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return typeof value === "string" ? value : "";
}

/** DB行を共有画面へ返す形へ整える。壊れた行は 500(data_corrupted) にして、画面を半端に描かせない。 */
export function toSharedDebt(row: DebtRow): Record<string, unknown> {
  const total = amount(row.total_yen, "total_yen");
  const privateNames: Array<[string, string]> = [
    [String(row.borrower_name ?? ""), "借主"],
    [String(row.creditor_name ?? ""), "貸主"],
  ];
  return {
    principal_yen: amount(row.principal_yen, "principal_yen"),
    interest_yen: amount(row.interest_yen, "interest_yen"),
    total_yen: total,
    paid_yen: amount(row.paid_yen, "paid_yen"),
    schedule: schedule(row.schedule_json),
    document: publicDocument(row.document_json, privateNames),
    updated_at: isoTimestamp(row.updated_at),
  };
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
  return toSharedDebt(await debtRow(token));
}

export async function loadSharedDebtPdf(token: string): Promise<{
  filename: string;
  mime_type: "application/pdf";
  data_base64: string;
}> {
  if (!isDebtShareToken(token)) inaccessible();
  const row = await firstRow<{ document_pdf: Buffer | null; pdf_filename: string | null }>(
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
  if (!row) inaccessible();
  // 有効なリンクを持つ人には、PDFだけ未登録であることを伝えてよい。
  if (!row.document_pdf?.length) throw new NotFound("原本PDFはまだ登録されていません。送信者へお問い合わせください。");
  return {
    filename: row.pdf_filename || "repayment-plan.pdf",
    mime_type: "application/pdf",
    data_base64: row.document_pdf.toString("base64"),
  };
}
