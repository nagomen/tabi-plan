#!/usr/bin/env node
// 既存の返済計画へ、債務者だけが使う操作リンクを発行する。
import mysql from "mysql2/promise";
import { createDebtActionToken, debtActionTokenHash, encryptDebtActionToken } from "../dist/debt-action-token.js";
import { newId } from "../dist/ids.js";

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : "";
};
const slug = arg("--slug");
if (!slug) throw new Error("Usage: node api/scripts/create-debt-action-link.mjs --slug <slug>");
for (const name of ["DB_USER", "DB_PASSWORD", "SESSION_SECRET"]) {
  if (!process.env[name]) throw new Error(`環境変数 ${name} が設定されていません`);
}

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
  const [plans] = await connection.query("SELECT id FROM debt_plans WHERE slug = ? LIMIT 1 FOR UPDATE", [slug]);
  const planId = plans[0]?.id;
  if (!planId) throw new Error("返済計画が見つかりません");
  const token = createDebtActionToken();
  await connection.query(
    "UPDATE debt_action_links SET revoked_at = CURRENT_TIMESTAMP WHERE plan_id = ? AND revoked_at IS NULL",
    [planId],
  );
  await connection.query(
    "INSERT INTO debt_action_links (id, plan_id, token_hash, token_ciphertext) VALUES (?, ?, ?, ?)",
    [newId("dact"), planId, debtActionTokenHash(token), encryptDebtActionToken(planId, token)],
  );
  await connection.commit();
  const base = String(process.env.DEBT_VIEWER_BASE_URL || "https://nagomen.github.io/tabi-plan/debt/").replace(/\/?$/, "/");
  process.stdout.write(`${base}#manage=${token}\n`);
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  await connection.end();
}
