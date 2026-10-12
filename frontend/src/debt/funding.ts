// 02 返済原資と月次収支計画。プラス（収入）とマイナス（支出）を色・符号・左右の列で分け、
// 最後に「手取り − 支出 ＝ 余力 − 返済 ＝ 返済後の余力」の計算式で結論を示す。
import type { BudgetItem, DebtDocument } from "./normalize";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const MINUS = "−";

type Sign = "plus" | "minus" | "auto";

function one<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`画面要素が見つかりません: ${selector}`);
  return node;
}

/** 符号つきの金額。auto は値の正負で＋/−を決める（余力など、マイナスになりうる値）。 */
function money(value: number, sign: Sign = "auto"): HTMLSpanElement {
  const node = document.createElement("span");
  const negative = sign === "minus" || (sign === "auto" && value < 0);
  node.className = `dn-money ${negative ? "is-negative" : "is-positive"}`;
  const prefix = sign === "minus" || value < 0 ? MINUS : sign === "plus" || value > 0 ? "+" : "";
  node.textContent = `${prefix}${yen.format(Math.abs(value)).replace(/^[-−]/, "")}`;
  return node;
}

/** 幅のある金額（最小〜最大）。両端を別々に色分けし、マイナスの端だけ赤くする。 */
function range(selector: string, minimum: number, maximum: number, sign: Sign = "auto"): void {
  const target = one<HTMLElement>(selector);
  target.replaceChildren(money(minimum, sign));
  if (minimum !== maximum) {
    const dash = document.createElement("span");
    dash.className = "dn-range-dash";
    dash.textContent = "〜";
    target.append(dash, money(maximum, sign));
  }
}

function setMoney(selector: string, value: number, sign: Sign): void {
  one<HTMLElement>(selector).replaceChildren(money(value, sign));
}

function rows(selector: string, items: BudgetItem[], sign: Sign): void {
  const list = one<HTMLElement>(selector);
  list.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    term.textContent = item.label;
    const detail = document.createElement("dd");
    detail.append(money(item.amount_yen, sign));
    row.append(term, detail);
    list.append(row);
  }
}

function renderLivingCostGroup(expenses: NonNullable<DebtDocument["expense_plan"]>): void {
  const group = expenses.living_cost_group;
  const panel = one<HTMLElement>("[data-living-cost-group]");
  panel.hidden = !group;
  if (!group) return;
  one<HTMLElement>("[data-living-cost-label]").textContent = group.label;
  one<HTMLElement>("[data-living-cost-subtotal]").replaceChildren("小計 ", money(group.subtotal_yen, "minus"));
  rows("[data-living-cost-items]", group.items, "minus");
  // 交通費支給などの差し引きは支出を減らす＝プラス。保存値は負数なので絶対値で＋表示する。
  rows("[data-living-cost-deductions]", group.deduction_items.map((item) => ({ ...item, amount_yen: Math.abs(item.amount_yen) })), "plus");
  setMoney("[data-living-cost-total]", group.total_yen, "minus");
}

interface FlowCase {
  label: string;
  net: number;
  buffer: number;
}

const SEGMENTS = [
  { key: "fixed", label: "固定費" },
  { key: "variable", label: "変動費" },
  { key: "repayment", label: "返済" },
  { key: "buffer", label: "残る余力" },
] as const;

/** 手取りを100%とした横棒。支出＋返済が手取りを超える月は、超えた分を「不足」として斜線で示す。 */
function renderFlowChart(documentData: DebtDocument): void {
  const income = documentData.income_plan!;
  const expenses = documentData.expense_plan!;
  const funding = documentData.funding_plan!;
  const fixed = Math.max(0, expenses.fixed_total_yen);
  const variable = Math.max(0, expenses.monthly_total_yen - fixed);
  const repayment = Math.max(0, funding.monthly_repayment_yen);
  const outflow = fixed + variable + repayment;
  const cases: FlowCase[] = income.estimated_net_income_min_yen === income.estimated_net_income_yen
    ? [{ label: "毎月", net: income.estimated_net_income_yen, buffer: funding.monthly_buffer_yen }]
    : [
      { label: "収入が多い月", net: income.estimated_net_income_yen, buffer: funding.monthly_buffer_yen },
      { label: "収入が少ない月", net: income.estimated_net_income_min_yen, buffer: funding.monthly_buffer_min_yen },
    ];
  const scale = Math.max(outflow, ...cases.map((item) => item.net), 1);
  const percent = (value: number): string => `${Math.max(0, value) / scale * 100}%`;

  const bars = one<HTMLElement>("[data-flow-bars]");
  bars.replaceChildren();
  for (const flow of cases) {
    const row = document.createElement("div");
    row.className = "dn-flow-bar-row";
    const head = document.createElement("p");
    head.className = "dn-flow-bar-head";
    const label = document.createElement("span");
    label.textContent = `${flow.label}・手取り ${yen.format(flow.net)}`;
    const result = document.createElement("strong");
    result.className = flow.buffer < 0 ? "is-negative" : "is-positive";
    result.textContent = flow.buffer < 0 ? `${yen.format(Math.abs(flow.buffer))} 不足` : `${yen.format(flow.buffer)} 残る`;
    head.append(label, result);

    const bar = document.createElement("div");
    bar.className = "dn-flow-bar";
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label",
      `${flow.label}：手取り${yen.format(flow.net)}のうち、固定費${yen.format(fixed)}、変動費${yen.format(variable)}、返済${yen.format(repayment)}。` +
      (flow.buffer < 0 ? `${yen.format(Math.abs(flow.buffer))}不足します。` : `${yen.format(flow.buffer)}残ります。`));
    const values = { fixed, variable, repayment, buffer: Math.max(0, flow.buffer) };
    for (const segment of SEGMENTS) {
      const value = values[segment.key];
      if (!value) continue;
      const part = document.createElement("span");
      part.className = `dn-flow-seg is-${segment.key}`;
      part.style.width = percent(value);
      bar.append(part);
    }
    if (flow.buffer < 0) {
      const shortage = document.createElement("span");
      shortage.className = "dn-flow-shortage";
      shortage.style.left = percent(flow.net);
      shortage.style.width = percent(outflow - flow.net);
      bar.append(shortage);
    }
    const marker = document.createElement("span");
    marker.className = "dn-flow-marker";
    marker.style.left = percent(flow.net);
    bar.append(marker);
    row.append(head, bar);
    bars.append(row);
  }

  const legend = one<HTMLElement>("[data-flow-legend]");
  legend.replaceChildren();
  const legendValues: Record<string, string> = {
    fixed: yen.format(fixed),
    variable: yen.format(variable),
    repayment: yen.format(repayment),
    buffer: cases.length > 1
      ? `${yen.format(Math.max(0, funding.monthly_buffer_min_yen))}〜${yen.format(Math.max(0, funding.monthly_buffer_yen))}`
      : yen.format(Math.max(0, funding.monthly_buffer_yen)),
  };
  for (const segment of SEGMENTS) {
    const item = document.createElement("li");
    const swatch = document.createElement("i");
    swatch.className = `is-${segment.key}`;
    const name = document.createElement("span");
    name.textContent = segment.label;
    const value = document.createElement("b");
    value.textContent = legendValues[segment.key];
    item.append(swatch, name, value);
    legend.append(item);
  }
  if (cases.some((item) => item.buffer < 0)) {
    const item = document.createElement("li");
    const swatch = document.createElement("i");
    swatch.className = "is-shortage";
    const name = document.createElement("span");
    name.textContent = "不足";
    item.append(swatch, name);
    legend.append(item);
  }
}

export function renderFundingPlan(documentData: DebtDocument): void {
  const income = documentData.income_plan;
  const expenses = documentData.expense_plan;
  const funding = documentData.funding_plan;
  if (!income || !expenses || !funding) return;

  one<HTMLElement>("[data-funding-intro]").textContent = income.description;
  one<HTMLElement>("[data-hourly-wage]").textContent = yen.format(income.hourly_wage_yen);
  one<HTMLElement>("[data-monthly-hours]").textContent = income.monthly_hours_min === income.monthly_hours_cap
    ? `${income.monthly_hours_cap}時間`
    : `${income.monthly_hours_min}〜${income.monthly_hours_cap}時間`;
  range("[data-gross-income]", income.gross_income_min_yen, income.gross_income_yen, "plus");
  range("[data-net-income]", income.estimated_net_income_min_yen, income.estimated_net_income_yen, "plus");

  rows("[data-fixed-expenses]", expenses.fixed_items, "minus");
  rows("[data-variable-expenses]", expenses.variable_items, "minus");
  renderLivingCostGroup(expenses);
  setMoney("[data-fixed-total]", expenses.fixed_total_yen, "minus");
  setMoney("[data-variable-total]", expenses.variable_total_yen, "minus");
  setMoney("[data-monthly-expenses]", expenses.monthly_total_yen, "minus");

  range("[data-cashflow-income]", income.estimated_net_income_min_yen, income.estimated_net_income_yen, "plus");
  setMoney("[data-cashflow-expenses]", expenses.monthly_total_yen, "minus");
  range("[data-available]", funding.monthly_available_min_yen, funding.monthly_available_yen);
  setMoney("[data-monthly-repayment]", funding.monthly_repayment_yen, "minus");
  range("[data-monthly-buffer]", funding.monthly_buffer_min_yen, funding.monthly_buffer_yen);
  renderFlowChart(documentData);

  one<HTMLElement>("[data-special-expense]").textContent = expenses.special_expense_note;

  const reducedMonths = income.reduced_income_months;
  if (reducedMonths.length) {
    const reducedIncome = one<HTMLElement>("[data-reduced-income]");
    reducedIncome.replaceChildren();
    for (const month of reducedMonths) {
      const item = document.createElement("article");
      const heading = document.createElement("h4");
      heading.textContent = month.label;
      const amount = document.createElement("strong");
      amount.append(money(month.net_income_yen, "plus"));
      const note = document.createElement("p");
      note.textContent = month.note;
      item.append(heading, amount, note);
      reducedIncome.append(item);
    }
    one<HTMLElement>("[data-reduced-income-panel]").hidden = false;
  }

  const actions = one<HTMLOListElement>("[data-funding-actions]");
  actions.replaceChildren();
  for (const action of funding.actions) {
    const item = document.createElement("li");
    item.textContent = action;
    actions.append(item);
  }
  one<HTMLElement>("[data-funding-plan]").hidden = false;
}
