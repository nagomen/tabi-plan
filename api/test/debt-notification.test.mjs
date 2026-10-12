import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const {
  createDebtActionToken,
  debtActionTokenHash,
  decryptDebtActionToken,
  encryptDebtActionToken,
} = await import("../dist/debt-action-token.js");

test("債務者操作トークンはハッシュ照合し、メール用の原文は計画IDに結びつけて暗号化する", () => {
  const token = createDebtActionToken();
  const encrypted = encryptDebtActionToken("debt_test", token);
  assert.equal(token.length, 43);
  assert.equal(debtActionTokenHash(token).length, 32);
  assert.equal(encrypted.includes(Buffer.from(token)), false);
  assert.equal(decryptDebtActionToken("debt_test", encrypted), token);
  assert.throws(() => decryptDebtActionToken("debt_other", encrypted));
});

test("返済通知は3日前リマインダーと返済完了を別々に一度だけ記録する", async () => {
  const migration = await readFile(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");
  const notifications = await readFile(new URL("../src/debt-notification-repo.ts", import.meta.url), "utf8");
  const routes = await readFile(new URL("../src/routes.ts", import.meta.url), "utf8");
  assert.match(migration, /UNIQUE KEY uq_debt_delivery \(plan_id, due_date, kind\)/);
  assert.match(notifications, /japanDatePlus\(3, now\)/);
  assert.match(notifications, /INSERT IGNORE INTO debt_notification_deliveries/);
  assert.match(notifications, /kind === "reminder"/);
  assert.match(routes, /\/api\/debt\/manage\/paid/);
});

test("日次のsystemd timerが日本時間の朝に通知ジョブを起動する", async () => {
  const timer = await readFile(new URL("../../infra/travel-debt-reminder.timer", import.meta.url), "utf8");
  const deploy = await readFile(new URL("../../infra/deploy-api.sh", import.meta.url), "utf8");
  assert.match(timer, /09:00:00 Asia\/Tokyo/);
  assert.match(timer, /Persistent=true/);
  assert.match(deploy, /install_debt_reminder_timer/);
});
