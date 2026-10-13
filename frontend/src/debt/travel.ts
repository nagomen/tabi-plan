// 旅行資金の積立見込み。勤務時間から手取りを出し、その月の支出と返済を引いた残りを貯まる額とする。
// 金額は保存データ（時給・支出・返済予定・税の扱い）から毎回計算し、コードに固定しない。
import type { DebtDocument, Installment, TravelPlan } from "./normalize";

export interface TravelSavingsMonth {
  month: string;
  /** その月の返済額（返済予定から） */
  repayment: number;
  outgo: number;
  low: { hours: number; net: number; saving: number };
  high: { hours: number; net: number; saving: number };
}

export interface TravelSavings {
  plan: TravelPlan;
  months: TravelSavingsMonth[];
  totalLow: number;
  totalHigh: number;
  reachesLow: boolean;
  reachesHigh: boolean;
}

/** 額面が非課税枠以下ならそのまま、超えたら手取り率を掛ける。 */
export function netFromHours(hours: number, hourlyWage: number, plan: Pick<TravelPlan, "tax_free_limit_yen" | "taxed_net_ratio">): number {
  const gross = hours * hourlyWage;
  return plan.tax_free_limit_yen && gross > plan.tax_free_limit_yen ? Math.round(gross * plan.taxed_net_ratio) : gross;
}

export function travelSavings(documentData: DebtDocument, schedule: Installment[]): TravelSavings | undefined {
  const plan = documentData.travel_plan;
  const income = documentData.income_plan;
  const expenses = documentData.expense_plan;
  if (!plan || !income || !expenses) return undefined;
  const months = plan.months.map((item) => {
    const repayment = schedule.filter((payment) => payment.due_date.startsWith(item.month)).reduce((sum, payment) => sum + payment.amount_yen, 0);
    const outgo = expenses.monthly_total_yen + repayment;
    const at = (hours: number) => {
      const net = netFromHours(hours, income.hourly_wage_yen, plan);
      return { hours, net, saving: net - outgo };
    };
    return { month: item.month, repayment, outgo, low: at(item.hours_min), high: at(item.hours_max) };
  });
  const totalLow = months.reduce((sum, item) => sum + item.low.saving, 0);
  const totalHigh = months.reduce((sum, item) => sum + item.high.saving, 0);
  return { plan, months, totalLow, totalHigh, reachesLow: totalLow >= plan.budget_min_yen, reachesHigh: totalHigh >= plan.budget_max_yen };
}
