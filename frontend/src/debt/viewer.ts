declare global {
  interface Window {
    TRIP_CONFIG?: { sharedBackend?: { apiBaseUrl?: string } };
  }
}

interface Installment {
  number: number;
  due_date: string;
  amount_yen: number;
  paid_at: string | null;
}

interface DebtDocument {
  submitted_on: string;
  monthly_income_yen: number;
  existing_debts: Array<{ creditor: string; amount_yen: number }>;
  difference_note: string;
  income_plan?: {
    hourly_wage_yen: number;
    monthly_hours_cap: number;
    gross_income_yen: number;
    estimated_net_income_yen: number;
    description: string;
  };
  expense_plan?: {
    fixed_items: Array<{ label: string; amount_yen: number }>;
    variable_items: Array<{ label: string; amount_yen: number }>;
    fixed_total_yen: number;
    variable_total_yen: number;
    monthly_total_yen: number;
    special_expense_note: string;
  };
  funding_plan?: {
    monthly_available_yen: number;
    monthly_repayment_yen: number;
    monthly_buffer_yen: number;
    actions: string[];
  };
  promises: Array<{ title: string; body: string }>;
  collateral_note: string;
  gambling_pledge: string;
  closing_note: string;
}

interface DebtPlan {
  borrower_name: string;
  creditor_name: string;
  principal_yen: number;
  interest_yen: number;
  total_yen: number;
  paid_yen: number;
  schedule: Installment[];
  document: DebtDocument;
  updated_at: string;
}

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const weekday = ["日", "月", "火", "水", "木", "金", "土"];

function one<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`画面要素が見つかりません: ${selector}`);
  return node;
}

function tokenFromFragment(): string {
  const fragment = location.hash.slice(1);
  const token = new URLSearchParams(fragment).get("token") || fragment;
  return decodeURIComponent(token).trim();
}

function apiBase(): string {
  return String(window.TRIP_CONFIG?.sharedBackend?.apiBaseUrl || "").replace(/\/+$/, "");
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(apiBase() + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(result.message || "返済計画を読み込めませんでした"));
  return result as T;
}

function setText(selector: string, value: string): void {
  one<HTMLElement>(selector).textContent = value;
}

function displayDate(iso: string, includeYear = true): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  const dayOfWeek = weekday[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return `${includeYear ? `${Number(year)}年` : ""}${Number(month)}月${Number(day)}日（${dayOfWeek}）`;
}

function todayInJapan(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function statusFor(item: Installment, today: string): { label: string; className: string } {
  if (item.paid_at) return { label: "返済済み", className: "is-paid" };
  if (item.due_date < today) return { label: "期日超過", className: "is-overdue" };
  if (item.due_date === today) return { label: "本日期日", className: "is-today" };
  return { label: "予定", className: "is-pending" };
}

function renderSchedule(plan: DebtPlan): void {
  const tbody = one<HTMLTableSectionElement>("[data-schedule]");
  const today = todayInJapan();
  let cumulative = 0;
  for (const item of plan.schedule) {
    cumulative += item.amount_yen;
    const row = document.createElement("tr");
    const status = statusFor(item, today);
    const values = [String(item.number), displayDate(item.due_date), yen.format(item.amount_yen), yen.format(cumulative)];
    for (const value of values) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const stateCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `dn-state ${status.className}`;
    badge.textContent = status.label;
    stateCell.append(badge);
    row.append(stateCell);
    tbody.append(row);
  }
  setText("[data-schedule-count]", `全${plan.schedule.length}回`);
}

function renderBudgetItems(selector: string, items: Array<{ label: string; amount_yen: number }>): void {
  const list = one<HTMLElement>(selector);
  for (const item of items) {
    const term = document.createElement("dt");
    term.textContent = item.label;
    const detail = document.createElement("dd");
    detail.textContent = yen.format(item.amount_yen);
    list.append(term, detail);
  }
}

function renderFundingPlan(documentData: DebtDocument): void {
  const income = documentData.income_plan;
  const expenses = documentData.expense_plan;
  const funding = documentData.funding_plan;
  if (!income || !expenses || !funding) return;

  setText("[data-funding-intro]", income.description);
  setText("[data-hourly-wage]", yen.format(income.hourly_wage_yen));
  setText("[data-monthly-hours]", `${income.monthly_hours_cap}時間`);
  setText("[data-gross-income]", yen.format(income.gross_income_yen));
  setText("[data-net-income]", yen.format(income.estimated_net_income_yen));
  renderBudgetItems("[data-fixed-expenses]", expenses.fixed_items);
  renderBudgetItems("[data-variable-expenses]", expenses.variable_items);
  setText("[data-fixed-total]", yen.format(expenses.fixed_total_yen));
  setText("[data-variable-total]", yen.format(expenses.variable_total_yen));
  setText("[data-cashflow-income]", yen.format(income.estimated_net_income_yen));
  setText("[data-monthly-expenses]", `− ${yen.format(expenses.monthly_total_yen)}`);
  setText("[data-available]", yen.format(funding.monthly_available_yen));
  setText("[data-monthly-repayment]", `− ${yen.format(funding.monthly_repayment_yen)}`);
  setText("[data-monthly-buffer]", yen.format(funding.monthly_buffer_yen));
  setText("[data-special-expense]", expenses.special_expense_note);

  const actions = one<HTMLOListElement>("[data-funding-actions]");
  for (const action of funding.actions) {
    const item = document.createElement("li");
    item.textContent = action;
    actions.append(item);
  }
  one<HTMLElement>("[data-funding-plan]").hidden = false;
}

function renderDocument(documentData: DebtDocument): void {
  setText("[data-income]", `現在の月収：約${yen.format(documentData.monthly_income_yen)}。`);
  const debts = one<HTMLElement>("[data-existing-debts]");
  let total = 0;
  for (const debt of documentData.existing_debts) {
    total += debt.amount_yen;
    const term = document.createElement("dt");
    term.textContent = debt.creditor;
    const detail = document.createElement("dd");
    detail.textContent = yen.format(debt.amount_yen);
    debts.append(term, detail);
  }
  const totalTerm = document.createElement("dt");
  totalTerm.textContent = "合計";
  const totalDetail = document.createElement("dd");
  totalDetail.textContent = yen.format(total);
  totalTerm.className = totalDetail.className = "is-total";
  debts.append(totalTerm, totalDetail);
  setText("[data-difference]", documentData.difference_note);

  const promises = one<HTMLElement>("[data-promises]");
  for (const promise of documentData.promises) {
    const block = document.createElement("article");
    const heading = document.createElement("h4");
    heading.textContent = promise.title;
    const body = document.createElement("p");
    body.textContent = promise.body;
    block.append(heading, body);
    promises.append(block);
  }
  setText("[data-collateral]", documentData.collateral_note);
  setText("[data-pledge]", documentData.gambling_pledge);
  setText("[data-closing]", documentData.closing_note);
  setText("[data-submitted]", displayDate(documentData.submitted_on));
  renderFundingPlan(documentData);
}

function render(plan: DebtPlan, token: string): void {
  const remaining = Math.max(0, plan.total_yen - plan.paid_yen);
  const paid = plan.schedule.filter((item) => Boolean(item.paid_at)).length;
  const next = plan.schedule.find((item) => !item.paid_at);
  const progress = plan.total_yen ? Math.min(100, Math.round(plan.paid_yen / plan.total_yen * 100)) : 0;
  setText("[data-borrower]", plan.borrower_name);
  setText("[data-creditor]", plan.creditor_name);
  setText("[data-remaining]", yen.format(remaining));
  setText("[data-progress-label]", `${progress}% 返済済み`);
  setText("[data-count-label]", `残り ${plan.schedule.length - paid}回`);
  one<HTMLElement>("[data-progress]").style.width = `${progress}%`;
  setText("[data-principal]", yen.format(plan.principal_yen));
  setText("[data-interest]", yen.format(plan.interest_yen));
  setText("[data-total]", yen.format(plan.total_yen));
  setText("[data-completion]", displayDate(plan.schedule.at(-1)?.due_date || ""));
  setText("[data-updated]", displayDate(plan.updated_at.slice(0, 10)));
  if (next) {
    setText("[data-next-date]", displayDate(next.due_date));
    setText("[data-next-amount]", yen.format(next.amount_yen));
    const status = statusFor(next, todayInJapan());
    const node = one<HTMLElement>("[data-next-status]");
    node.textContent = status.label;
    node.className = `dn-state ${status.className}`;
  } else {
    setText("[data-next-date]", "完済");
    setText("[data-next-amount]", yen.format(0));
    setText("[data-next-status]", "すべて返済済み");
  }
  renderSchedule(plan);
  renderDocument(plan.document);

  one<HTMLButtonElement>("[data-download]").addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const original = button.textContent || "原本PDFをダウンロード";
    button.disabled = true;
    button.textContent = "PDFを準備中…";
    try {
      const result = await post<{ filename: string; mime_type: string; data_base64: string }>(
        "/api/debt/share/pdf", { token },
      );
      const binary = atob(result.data_base64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mime_type || "application/pdf" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename || "repayment-plan.pdf";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
      alert(error instanceof Error ? error.message : "PDFを取得できませんでした");
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  });
}

export async function initDebtViewer(): Promise<void> {
  const loading = one<HTMLElement>("[data-loading]");
  const content = one<HTMLElement>("[data-content]");
  const errorPanel = one<HTMLElement>("[data-error]");
  try {
    const token = tokenFromFragment();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("共有URLが正しくありません。URL全体をコピーして開いてください。");
    const plan = await post<DebtPlan>("/api/debt/share", { token });
    render(plan, token);
    content.hidden = false;
  } catch (error) {
    setText("[data-error-message]", error instanceof Error ? error.message : "返済計画を読み込めませんでした");
    errorPanel.hidden = false;
  } finally {
    loading.hidden = true;
    document.documentElement.classList.add("ui-ready");
  }
}
