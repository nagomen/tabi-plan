import { all, pool } from "./db.js";
import { decryptDebtActionToken } from "./debt-action-token.js";
import { config } from "./config.js";
import { newId } from "./ids.js";
import { mailConfigured, sendTextMail } from "./mailer.js";

type DeliveryKind = "reminder" | "payment_confirmation";

interface ReminderPlanRow {
  id: string;
  schedule_json: unknown;
}

interface DeliveryRow {
  id: string;
  plan_id: string;
  due_date: string;
  kind: DeliveryKind;
  borrower_name: string;
  borrower_email: string;
  creditor_name: string;
  creditor_email: string;
  schedule_json: unknown;
  token_ciphertext: Buffer | null;
}

interface Installment {
  due_date: string;
  amount_yen: number;
  paid_at: string | null;
}

function schedule(value: unknown): Installment[] {
  let parsed = value;
  if (typeof value === "string" || Buffer.isBuffer(value)) parsed = JSON.parse(value.toString());
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const dueDate = String(item.due_date || "");
    const amount = Number(item.amount_yen || 0);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(amount) || amount <= 0) return [];
    return [{ due_date: dueDate, amount_yen: Math.round(amount), paid_at: typeof item.paid_at === "string" && item.paid_at ? item.paid_at : null }];
  });
}

function japanDatePlus(days: number, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const today = formatter.format(now);
  const instant = new Date(`${today}T00:00:00+09:00`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return formatter.format(instant);
}

const yen = (value: number): string => `${new Intl.NumberFormat("ja-JP").format(value)}円`;
const displayDate = (value: string): string => `${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;

export async function enqueueUpcomingReminders(now = new Date()): Promise<number> {
  const target = japanDatePlus(3, now);
  const plans = await all<ReminderPlanRow>("SELECT id, schedule_json FROM debt_plans");
  let queued = 0;
  for (const plan of plans) {
    if (!schedule(plan.schedule_json).some((item) => item.due_date === target && !item.paid_at)) continue;
    const [result] = await pool.query(
      `INSERT IGNORE INTO debt_notification_deliveries
        (id, plan_id, due_date, kind, status, next_attempt_at)
       VALUES (?, ?, ?, 'reminder', 'pending', CURRENT_TIMESTAMP)`,
      [newId("dmail"), plan.id, target],
    );
    queued += Number((result as { affectedRows?: number }).affectedRows || 0);
  }
  return queued;
}

function mailFor(row: DeliveryRow): { to: string; subject: string; text: string } {
  const installment = schedule(row.schedule_json).find((item) => item.due_date === row.due_date);
  if (!installment) throw new Error("notification installment no longer exists");
  if (row.kind === "reminder") {
    if (!row.token_ciphertext) throw new Error("active debt action link is missing");
    const token = decryptDebtActionToken(row.plan_id, row.token_ciphertext);
    const url = `${config.mail.debtViewerBaseUrl}#manage=${encodeURIComponent(token)}`;
    return {
      to: row.borrower_email,
      subject: `【返す日】${displayDate(row.due_date)}の返済予定のお知らせ`,
      text: `${row.borrower_name}さん\n\n返済日の3日前になりました。\n\n返済日：${displayDate(row.due_date)}\n返済額：${yen(installment.amount_yen)}\n\n振込後、次の債務者専用ページから「返済した」を押してください。\n${url}\n\nこのメールは返済計画に基づいて自動送信されています。`,
    };
  }
  return {
    to: row.creditor_email,
    subject: `【返す日】${displayDate(row.due_date)}分の返済完了のお知らせ`,
    text: `${row.creditor_name}さん\n\n${row.borrower_name}さんが返済を記録しました。\n\n対象返済日：${displayDate(row.due_date)}\n返済額：${yen(installment.amount_yen)}\n\n実際の入金状況は口座明細でご確認ください。\n\nこのメールは返済計画に基づいて自動送信されています。`,
  };
}

export async function deliverPendingNotifications(planId = ""): Promise<{ sent: number; failed: number; configured: boolean }> {
  if (!mailConfigured()) return { sent: 0, failed: 0, configured: false };
  await pool.query(
    `UPDATE debt_notification_deliveries
        SET status = 'failed', next_attempt_at = CURRENT_TIMESTAMP
      WHERE status = 'sending' AND updated_at < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE)`,
  );
  const rows = await all<DeliveryRow>(
    `SELECT d.id, d.plan_id, DATE_FORMAT(d.due_date, '%Y-%m-%d') AS due_date, d.kind,
            p.borrower_name, p.borrower_email, p.creditor_name, p.creditor_email, p.schedule_json,
            a.token_ciphertext
       FROM debt_notification_deliveries d
       JOIN debt_plans p ON p.id = d.plan_id
       LEFT JOIN debt_action_links a ON a.plan_id = p.id AND a.revoked_at IS NULL
            AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
      WHERE d.status IN ('pending','failed')
        AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= CURRENT_TIMESTAMP)
        ${planId ? "AND d.plan_id = ?" : ""}
      ORDER BY d.created_at
      LIMIT 100`,
    planId ? [planId] : [],
  );
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const [claim] = await pool.query(
      `UPDATE debt_notification_deliveries
          SET status = 'sending', attempts = attempts + 1
        WHERE id = ? AND status IN ('pending','failed')`,
      [row.id],
    );
    if (Number((claim as { affectedRows?: number }).affectedRows || 0) !== 1) continue;
    try {
      const messageId = await sendTextMail(mailFor(row));
      await pool.query(
        `UPDATE debt_notification_deliveries
            SET status = 'sent', sent_at = CURRENT_TIMESTAMP, message_id = ?, last_error = NULL, next_attempt_at = NULL
          WHERE id = ?`,
        [messageId, row.id],
      );
      sent += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await pool.query(
        `UPDATE debt_notification_deliveries
            SET status = 'failed', last_error = ?, next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 1 HOUR)
          WHERE id = ?`,
        [message, row.id],
      );
      failed += 1;
      console.error("[debt-mail] delivery failed", JSON.stringify({ id: row.id, kind: row.kind }), error);
    }
  }
  return { sent, failed, configured: true };
}
