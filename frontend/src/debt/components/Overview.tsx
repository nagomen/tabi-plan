import { displayDate, todayInJapan, yen } from "../format";
import type { DebtPlan, Installment } from "../normalize";
import { statusFor, type PaymentState } from "../schedule";
import { Icon } from "./Icon";
import { StateBadge } from "./StateBadge";

interface OverviewProps {
  plan: DebtPlan;
  /** 選択中の進路を反映した返済予定。 */
  schedule: Installment[];
}

function nextPayment(schedule: Installment[]): { date: string; amount: string; state: PaymentState } {
  const payments = schedule.filter((item) => item.amount_yen > 0);
  const next = payments.find((item) => !item.paid_at);
  if (next) return { date: displayDate(next.due_date), amount: yen.format(next.amount_yen), state: statusFor(next, todayInJapan()) };
  // 返済予定が未登録のときに「完済」と誤表示しない。
  if (!payments.length) return { date: "未定", amount: "—", state: { label: "返済予定未登録", className: "is-pending", icon: "clock" } };
  return { date: "完済", amount: yen.format(0), state: { label: "すべて返済済み", className: "is-paid", icon: "checkCircle" } };
}

export function Overview({ plan, schedule }: OverviewProps) {
  const remaining = Math.max(0, plan.total_yen - plan.paid_yen);
  const progress = plan.total_yen ? Math.min(100, Math.round(plan.paid_yen / plan.total_yen * 100)) : 0;
  const payments = schedule.filter((item) => item.amount_yen > 0);
  const paidCount = payments.filter((item) => Boolean(item.paid_at)).length;
  const next = nextPayment(schedule);

  return (
    <section className="dn-overview" id="status" aria-labelledby="dn-overview-title">
      <header className="dn-ov-head">
        <div>
          <p className="dn-eyebrow">REPAYMENT PLAN / 2026–2027</p>
          <h1 id="dn-overview-title">返済計画</h1>
          <p className="dn-ov-lead">個人情報を表示しない、閲覧専用の返済記録です。</p>
        </div>
        <p className="dn-ov-updated"><Icon name="clock" />最終更新 <time>{displayDate(plan.updated_at.slice(0, 10))}</time></p>
      </header>

      <div className="dn-ov-main">
        <div className="dn-ov-balance">
          <p className="dn-ov-label"><Icon name="banknotes" />残りの返済額</p>
          <strong className="dn-ov-amount">{yen.format(remaining)}</strong>
          <div className="dn-ov-progress" aria-hidden="true"><span style={{ width: `${progress}%` }}></span></div>
          <p className="dn-ov-meta">
            <span><Icon name="checkCircle" /><span>{progress}% 返済済み</span></span>
            <span>残り {payments.length - paidCount}回</span>
          </p>
        </div>
        <div className="dn-ov-next">
          <p className="dn-ov-label"><Icon name="calendarDays" />次回の返済</p>
          <div className="dn-ov-next-body">
            <strong className="dn-ov-next-date">{next.date}</strong>
            <b className="dn-ov-next-amount">{next.amount}</b>
          </div>
          <StateBadge state={next.state} />
        </div>
      </div>

      <dl className="dn-ov-facts" aria-label="借入条件">
        <div><dt><Icon name="currencyYen" />借入元金</dt><dd>{yen.format(plan.principal_yen)}</dd></div>
        <div><dt><Icon name="receiptPercent" />利息</dt><dd>{yen.format(plan.interest_yen)}</dd></div>
        <div><dt><Icon name="calculator" />返済総額</dt><dd>{yen.format(plan.total_yen)}</dd></div>
        <div><dt><Icon name="flag" />完済予定</dt><dd>{displayDate(schedule.at(-1)?.due_date || "")}</dd></div>
      </dl>
    </section>
  );
}
