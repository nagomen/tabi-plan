// 「手取りの使い道」帯グラフの計算。手取りを100%とし、支出＋返済が手取りを超える月は不足として扱う。
import type { DebtDocument } from "./normalize";

export type SegmentKey = "fixed" | "variable" | "repayment" | "buffer";

export const SEGMENTS: Array<{ key: SegmentKey; label: string }> = [
  { key: "fixed", label: "固定費" },
  { key: "variable", label: "変動費" },
  { key: "repayment", label: "返済" },
  { key: "buffer", label: "残るお金" },
];

export interface FlowCase {
  label: string;
  net: number;
  buffer: number;
  /** 幅(%)。scale に対する割合。 */
  widths: Record<SegmentKey, number>;
  netAt: number;
  shortage?: { left: number; width: number };
}

export interface FlowChart {
  fixed: number;
  variable: number;
  repayment: number;
  cases: FlowCase[];
}

export function flowChart(documentData: DebtDocument): FlowChart | undefined {
  const income = documentData.income_plan;
  const expenses = documentData.expense_plan;
  const funding = documentData.funding_plan;
  if (!income || !expenses || !funding) return undefined;
  const fixed = Math.max(0, expenses.fixed_total_yen);
  const variable = Math.max(0, expenses.monthly_total_yen - fixed);
  const repayment = Math.max(0, funding.monthly_repayment_yen);
  const outflow = fixed + variable + repayment;
  const raw = income.estimated_net_income_min_yen === income.estimated_net_income_yen
    ? [{ label: "毎月", net: income.estimated_net_income_yen, buffer: funding.monthly_buffer_yen }]
    : [
      { label: "収入が多い月", net: income.estimated_net_income_yen, buffer: funding.monthly_buffer_yen },
      { label: "収入が少ない月", net: income.estimated_net_income_min_yen, buffer: funding.monthly_buffer_min_yen },
    ];
  const scale = Math.max(outflow, ...raw.map((item) => item.net), 1);
  const percent = (value: number): number => Math.max(0, value) / scale * 100;
  return {
    fixed,
    variable,
    repayment,
    cases: raw.map((item) => ({
      ...item,
      widths: { fixed: percent(fixed), variable: percent(variable), repayment: percent(repayment), buffer: percent(item.buffer) },
      netAt: percent(item.net),
      shortage: item.buffer < 0 ? { left: percent(item.net), width: percent(outflow - item.net) } : undefined,
    })),
  };
}
