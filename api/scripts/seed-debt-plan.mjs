#!/usr/bin/env node
// 管理者がVPS上でだけ実行する返済計画の登録スクリプト。
// 個人情報・原本PDF・共有トークンをGitリポジトリへ置かず、MySQLへ直接登録する。

import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || "" : "";
}

const inputPath = option("--input");
const pdfPath = option("--pdf");
if (!inputPath || !pdfPath) {
  console.error("Usage: node api/scripts/seed-debt-plan.mjs --input plan.json --pdf document.pdf");
  process.exit(1);
}
for (const name of ["DB_USER", "DB_PASSWORD"]) {
  if (!process.env[name]) throw new Error(`環境変数 ${name} が設定されていません`);
}

const plan = JSON.parse(await readFile(inputPath, "utf8"));
const pdf = await readFile(pdfPath);
const money = (value, label) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 100_000_000) {
    throw new Error(`${label} が不正です`);
  }
  return number;
};
const text = (value, label, max = 255) => {
  const result = String(value || "").trim();
  if (!result || result.length > max) throw new Error(`${label} が不正です`);
  return result;
};
const schedule = Array.isArray(plan.schedule) ? plan.schedule : [];
if (!schedule.length || schedule.length > 120) throw new Error("返済スケジュールが不正です");
const normalizedSchedule = schedule.map((item, index) => ({
  number: index + 1,
  due_date: /^\d{4}-\d{2}-\d{2}$/.test(String(item.due_date || "")) ? item.due_date : (() => { throw new Error("返済日が不正です"); })(),
  amount_yen: money(item.amount_yen, "返済額"),
  paid_at: item.paid_at || null,
}));
const principal = money(plan.principal_yen, "元金");
const interest = money(plan.interest_yen, "利息");
const total = money(plan.total_yen, "返済総額");
if (principal + interest !== total) throw new Error("元金と利息の合計が返済総額と一致しません");
if (normalizedSchedule.reduce((sum, item) => sum + item.amount_yen, 0) !== total) {
  throw new Error("返済スケジュールの合計が返済総額と一致しません");
}
if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("PDF原本を確認できません");

const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const token = crypto.randomBytes(32).toString("base64url");
const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest();
const connection = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "TravelPlan",
  charset: "utf8mb4",
});

try {
  await connection.beginTransaction();
  const slug = text(plan.slug, "slug", 64);
  const [existing] = await connection.query("SELECT id FROM debt_plans WHERE slug = ? LIMIT 1 FOR UPDATE", [slug]);
  const planId = existing[0]?.id || randomId("debt");
  await connection.query(
    `INSERT INTO debt_plans
      (id, slug, borrower_name, borrower_email, creditor_name, creditor_email,
       principal_yen, interest_yen, total_yen, paid_yen, schedule_json, document_json,
       document_pdf, pdf_filename)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       borrower_name = VALUES(borrower_name), borrower_email = VALUES(borrower_email),
       creditor_name = VALUES(creditor_name), creditor_email = VALUES(creditor_email),
       principal_yen = VALUES(principal_yen), interest_yen = VALUES(interest_yen),
       total_yen = VALUES(total_yen), paid_yen = VALUES(paid_yen),
       schedule_json = VALUES(schedule_json), document_json = VALUES(document_json),
       document_pdf = VALUES(document_pdf), pdf_filename = VALUES(pdf_filename)`,
    [
      planId, slug, text(plan.borrower_name, "債務者名", 64), text(plan.borrower_email, "債務者メール"),
      text(plan.creditor_name, "債権者名", 64), text(plan.creditor_email, "債権者メール"),
      principal, interest, total, money(plan.paid_yen || 0, "返済済み額"),
      JSON.stringify(normalizedSchedule), JSON.stringify(plan.document || {}), pdf,
      text(plan.pdf_filename || "repayment_plan_final.pdf", "PDFファイル名", 191),
    ],
  );
  await connection.query(
    "UPDATE debt_share_links SET revoked_at = CURRENT_TIMESTAMP WHERE plan_id = ? AND revoked_at IS NULL",
    [planId],
  );
  await connection.query(
    "INSERT INTO debt_share_links (id, plan_id, token_hash) VALUES (?, ?, ?)",
    [randomId("dshr"), planId, tokenHash],
  );
  await connection.commit();
  const base = String(process.env.DEBT_VIEWER_BASE_URL || "https://nagomen.github.io/tabi-plan/debt/").replace(/\/?$/, "/");
  process.stdout.write(`${base}#${token}\n`);
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
