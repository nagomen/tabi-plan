// 返済予定の組み立てと状態判定。表示コンポーネントから切り離してテストできるようにする。
import type { IconName } from "../shared/icons";
import type { DebtPlan, Installment, RepaymentScenario } from "./normalize";

export interface PaymentState {
  label: string;
  className: string;
  icon: IconName;
}

export function statusFor(item: Installment, today: string): PaymentState {
  if (item.amount_yen === 0) return { label: "返済猶予", className: "is-deferred", icon: "pauseCircle" };
  if (item.paid_at) return { label: "返済済み", className: "is-paid", icon: "checkCircle" };
  if (item.due_date < today) return { label: "期日超過", className: "is-overdue", icon: "exclamationTriangle" };
  if (item.due_date === today) return { label: "本日期日", className: "is-today", icon: "calendarDays" };
  return { label: "予定", className: "is-pending", icon: "clock" };
}

/** 3月までの共通計画を保ったまま、4月以降を選んだ進路の予定へ差し替える。 */
export function scheduleForScenario(plan: DebtPlan, scenario: RepaymentScenario): Installment[] {
  const scenarioSchedule = [...scenario.schedule].sort((a, b) => a.due_date.localeCompare(b.due_date));
  const firstScenarioDate = scenarioSchedule.at(0)?.due_date;
  const common = firstScenarioDate
    ? plan.schedule.filter((item) => item.due_date < firstScenarioDate)
    : [...plan.schedule];
  const savedByDate = new Map(plan.schedule.map((item) => [item.due_date, item]));
  let paymentNumber = common.filter((item) => item.amount_yen > 0).length;
  const selected = scenarioSchedule.map((item) => {
    const saved = savedByDate.get(item.due_date);
    if (item.amount_yen > 0) paymentNumber += 1;
    return {
      number: item.amount_yen > 0 ? paymentNumber : 0,
      due_date: item.due_date,
      amount_yen: item.amount_yen,
      paid_at: saved?.amount_yen === item.amount_yen ? saved.paid_at : null,
    };
  });
  return [...common, ...selected];
}

export interface RepaymentPeriod {
  months: string[];
  amount: number;
}

/**
 * 返済額が同じ月をまとめた期間。完済月だけ端数が小さくなる最終回は、
 * 独立した期間として出すと「毎月の返済」と誤読されるので除く。
 */
export function repaymentPeriods(schedule: RepaymentScenario["schedule"]): RepaymentPeriod[] {
  const periods: RepaymentPeriod[] = [];
  for (const item of [...schedule].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
    if (item.amount_yen <= 0) continue;
    const month = item.due_date.slice(0, 7);
    const last = periods.at(-1);
    if (last && last.amount === item.amount_yen) last.months.push(month);
    else periods.push({ months: [month], amount: item.amount_yen });
  }
  const final = periods.at(-1);
  const previous = periods.at(-2);
  if (final && previous && final.months.length === 1 && final.amount < previous.amount) periods.pop();
  return periods;
}

export function periodLabel(months: string[], isLast: boolean): string {
  const numbers = months.map((month) => Number(month.slice(5, 7)));
  if (isLast) return `${numbers[0]}月以降`;
  if (numbers.length === 1) return `${numbers[0]}月`;
  if (numbers.length === 2) return `${numbers[0]}・${numbers[1]}月`;
  return `${numbers[0]}〜${numbers.at(-1)}月`;
}

export interface LeftoverRow {
  label: string;
  minimum: number;
  maximum: number;
}

/** 返済後に残るお金 = 手取り − 支出 − 返済。返済額が変わるルートは期間ごとに分ける。 */
export function scenarioLeftover(scenario: RepaymentScenario): LeftoverRow[] {
  const periods = repaymentPeriods(scenario.schedule);
  const expenses = scenario.monthly_expenses_yen;
  const row = (label: string, amount: number): LeftoverRow => ({
    label,
    minimum: scenario.net_income_min_yen - expenses - amount,
    maximum: scenario.net_income_yen - expenses - amount,
  });
  if (periods.length <= 1) return [row("", periods[0]?.amount ?? scenario.monthly_repayment_yen)];
  return periods.map((period, index) => row(periodLabel(period.months, index === periods.length - 1), period.amount));
}

/** 既定で開く進路。留年ルートがあればそれを、なければ先頭を選ぶ。 */
export function defaultScenario(scenarios: RepaymentScenario[]): RepaymentScenario | undefined {
  return scenarios.find((scenario) => scenario.id === "repeat-year") || scenarios[0];
}
