import { useState } from "react";
import { post } from "../api";
import { describe } from "../errors";
import { displayDate, yen } from "../format";
import { normalizePlan, type DebtPlan } from "../normalize";

interface PaymentActionProps {
  plan: DebtPlan;
  token: string;
  /** 記録後にサーバーから返った最新の計画で画面を描き直す。 */
  onUpdated: (plan: DebtPlan) => void;
}

/** 債務者専用リンクだけに出す「返済した」ボタン。記録すると貸主へメールで知らせる。 */
export function PaymentAction({ plan, token, onUpdated }: PaymentActionProps) {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const next = plan.schedule.find((item) => item.amount_yen > 0 && !item.paid_at);

  const markPaid = async (): Promise<void> => {
    if (!next) return;
    if (!confirm(`${displayDate(next.due_date)}の${yen.format(next.amount_yen)}を振り込み済みとして記録しますか？`)) return;
    setBusy(true);
    setFeedback("返済を記録しています…");
    try {
      const result = await post("/api/debt/manage/paid", { token, due_date: next.due_date });
      const body = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
      onUpdated(normalizePlan(body.plan));
      setFeedback(body.notification === "sent"
        ? "返済を記録し、貸主へメールを送信しました。"
        : "返済を記録しました。貸主へのメールは送信待ちです。");
    } catch (error) {
      setFeedback(describe(error, "返済を記録できませんでした。").message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="dn-payment-action">
      <div>
        <p className="dn-payment-eyebrow">DEBTOR ACTION</p>
        <h2>振り込みは完了しましたか？</h2>
        <p>{next
          ? `${displayDate(next.due_date)}・${yen.format(next.amount_yen)}の返済を記録し、貸主へメールで知らせます。`
          : "すべての返済が記録されています。"}</p>
        <p className="dn-payment-feedback" aria-live="polite">{feedback}</p>
      </div>
      {next && <button type="button" disabled={busy} onClick={() => void markPaid()}><span>返済した</span></button>}
    </aside>
  );
}
