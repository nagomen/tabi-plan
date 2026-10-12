import { DebtViewerError, post } from "./api";
import {
  normalizePdf, normalizePlan,
  type DebtDocument, type DebtPlan, type Installment,
} from "./normalize";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const weekday = ["日", "月", "火", "水", "木", "金", "土"];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function one<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  // HTMLとJSの版がずれた（古いキャッシュ）ときに起きる。利用者には再読み込みを案内する。
  if (!node) throw new Error(`画面要素が見つかりません: ${selector}`);
  return node;
}

function tokenFromFragment(): string {
  const fragment = location.hash.slice(1);
  const token = new URLSearchParams(fragment).get("token") || fragment;
  try {
    return decodeURIComponent(token).trim();
  } catch {
    // %の後ろが欠けた貼り付けなど。形式チェックで「URLが正しくない」と案内する。
    return "";
  }
}

function setText(selector: string, value: string): void {
  one<HTMLElement>(selector).textContent = value;
}

function displayDate(iso: string, includeYear = true): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso || "未定";
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
  if (item.amount_yen === 0) return { label: "返済猶予", className: "is-deferred" };
  if (item.paid_at) return { label: "返済済み", className: "is-paid" };
  if (item.due_date < today) return { label: "期日超過", className: "is-overdue" };
  if (item.due_date === today) return { label: "本日期日", className: "is-today" };
  return { label: "予定", className: "is-pending" };
}

function renderSchedule(plan: DebtPlan): void {
  const tbody = one<HTMLTableSectionElement>("[data-schedule]");
  // 再試行で描き直しても行が二重にならないよう、毎回空にしてから積む。
  tbody.replaceChildren();
  const today = todayInJapan();
  let cumulative = 0;
  for (const item of plan.schedule) {
    cumulative += item.amount_yen;
    const row = document.createElement("tr");
    const status = statusFor(item, today);
    const values = [item.amount_yen === 0 ? "—" : String(item.number), displayDate(item.due_date), yen.format(item.amount_yen), yen.format(cumulative)];
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
  if (!plan.schedule.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "返済予定はまだ登録されていません。";
    row.append(cell);
    tbody.append(row);
  }
  const paymentCount = plan.schedule.filter((item) => item.amount_yen > 0).length;
  const deferredCount = plan.schedule.length - paymentCount;
  setText("[data-schedule-count]", deferredCount ? `全${paymentCount}回返済・${deferredCount}か月猶予` : `全${paymentCount}回`);
}

function renderBudgetItems(selector: string, items: Array<{ label: string; amount_yen: number }>): void {
  const list = one<HTMLElement>(selector);
  list.replaceChildren();
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

  const reducedMonths = income.reduced_income_months;
  if (reducedMonths.length) {
    const reducedIncome = one<HTMLElement>("[data-reduced-income]");
    reducedIncome.replaceChildren();
    for (const month of reducedMonths) {
      const item = document.createElement("article");
      const heading = document.createElement("h4");
      heading.textContent = month.label;
      const amount = document.createElement("strong");
      amount.textContent = yen.format(month.net_income_yen);
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

function renderRepaymentScenarios(documentData: DebtDocument): void {
  const scenarios = documentData.repayment_scenarios;
  if (!scenarios.length) return;
  const container = one<HTMLElement>("[data-repayment-scenarios]");
  container.replaceChildren();
  for (const scenario of scenarios) {
    const card = document.createElement("article");
    card.className = "dn-scenario";
    card.dataset.scenario = scenario.id;

    const heading = document.createElement("h3");
    heading.textContent = scenario.title;
    const income = document.createElement("p");
    income.className = "dn-scenario-income";
    income.textContent = `4月以降の想定手取り ${yen.format(scenario.net_income_yen)}`;

    const metrics = document.createElement("dl");
    for (const [label, value] of [
      ["月の支出", yen.format(scenario.monthly_expenses_yen)],
      ["毎月の返済", yen.format(scenario.monthly_repayment_yen)],
      ["返済後の予備費", yen.format(scenario.monthly_buffer_yen)],
      ["完済予定", displayDate(scenario.completion_date)],
    ]) {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      metrics.append(term, detail);
    }

    const schedule = document.createElement("p");
    schedule.className = "dn-scenario-schedule";
    schedule.textContent = scenario.schedule
      .map((item) => `${Number(item.due_date.slice(5, 7))}/${Number(item.due_date.slice(8, 10))} ${yen.format(item.amount_yen)}`)
      .join(" · ");
    const note = document.createElement("p");
    note.className = "dn-scenario-note";
    note.textContent = scenario.note;
    card.append(heading, income, metrics, schedule, note);
    container.append(card);
  }
  one<HTMLElement>("[data-scenarios-panel]").hidden = false;
}

function renderDocument(documentData: DebtDocument): void {
  setText("[data-income]", `現在の月収：約${yen.format(documentData.monthly_income_yen)}。`);
  const debts = one<HTMLElement>("[data-existing-debts]");
  debts.replaceChildren();
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
  promises.replaceChildren();
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
  renderRepaymentScenarios(documentData);
}

/** 利用者へ出す文言。想定外の例外（描画の不具合など）は英語の内部メッセージを見せない。 */
function describe(error: unknown, fallback: string): DebtViewerError {
  if (error instanceof DebtViewerError) return error;
  console.error("[debt-viewer]", error);
  return new DebtViewerError(
    `${fallback}ページを再読み込みしてください。続く場合は送信者へお知らせください。`,
    "返済計画を表示できませんでした",
    true,
  );
}

function base64Bytes(data: string): ArrayBuffer {
  let binary: string;
  try {
    binary = atob(data);
  } catch {
    throw new DebtViewerError("原本PDFのデータが壊れているため保存できません。送信者へお知らせください。", "PDFを取得できませんでした");
  }
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return buffer;
}

async function downloadPdf(button: HTMLButtonElement, token: string): Promise<void> {
  if (button.disabled) return;
  const original = button.textContent || "原本PDFをダウンロード";
  button.disabled = true;
  button.textContent = "PDFを準備中…";
  try {
    const pdf = normalizePdf(await post("/api/debt/share/pdf", { token }));
    const blob = new Blob([base64Bytes(pdf.data_base64)], { type: pdf.mime_type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = pdf.filename;
    link.rel = "noopener";
    // Firefox は文書に入っていないリンクの click を無視する。
    document.body.append(link);
    link.click();
    link.remove();
    // モバイルやアプリ内ブラウザは保存開始が遅いので、すぐに失効させない。
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    const problem = describe(error, "PDFを取得できませんでした。");
    const wait = problem.retryAfter ? `（${problem.retryAfter}秒ほど待ってから）` : "";
    alert(`${problem.message}${problem.retryable && wait ? `\n${wait}もう一度お試しください。` : ""}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function render(plan: DebtPlan, token: string): void {
  const remaining = Math.max(0, plan.total_yen - plan.paid_yen);
  const paymentSchedule = plan.schedule.filter((item) => item.amount_yen > 0);
  const paid = paymentSchedule.filter((item) => Boolean(item.paid_at)).length;
  const next = paymentSchedule.find((item) => !item.paid_at);
  const progress = plan.total_yen ? Math.min(100, Math.round(plan.paid_yen / plan.total_yen * 100)) : 0;
  setText("[data-borrower]", plan.borrower_name);
  setText("[data-creditor]", plan.creditor_name);
  setText("[data-remaining]", yen.format(remaining));
  setText("[data-progress-label]", `${progress}% 返済済み`);
  setText("[data-count-label]", `残り ${paymentSchedule.length - paid}回`);
  one<HTMLElement>("[data-progress]").style.width = `${progress}%`;
  setText("[data-principal]", yen.format(plan.principal_yen));
  setText("[data-interest]", yen.format(plan.interest_yen));
  setText("[data-total]", yen.format(plan.total_yen));
  setText("[data-completion]", displayDate(plan.schedule.at(-1)?.due_date || ""));
  setText("[data-updated]", displayDate(plan.updated_at.slice(0, 10)));
  const nextStatus = one<HTMLElement>("[data-next-status]");
  if (next) {
    setText("[data-next-date]", displayDate(next.due_date));
    setText("[data-next-amount]", yen.format(next.amount_yen));
    const status = statusFor(next, todayInJapan());
    nextStatus.textContent = status.label;
    nextStatus.className = `dn-state ${status.className}`;
  } else if (!paymentSchedule.length) {
    // 返済予定が未登録のときに「完済」と誤表示しない。
    setText("[data-next-date]", "未定");
    setText("[data-next-amount]", "—");
    nextStatus.textContent = "返済予定未登録";
    nextStatus.className = "dn-state is-pending";
  } else {
    setText("[data-next-date]", "完済");
    setText("[data-next-amount]", yen.format(0));
    nextStatus.textContent = "すべて返済済み";
    nextStatus.className = "dn-state is-paid";
  }
  renderSchedule(plan);
  renderDocument(plan.document);

  // onclick への代入なので、描き直しても処理が二重登録されない。
  const download = one<HTMLButtonElement>("[data-download]");
  download.onclick = () => { void downloadPdf(download, token); };
}

function startRetryCountdown(button: HTMLButtonElement, seconds: number): void {
  const label = "もう一度読み込む";
  let left = Math.min(seconds, 600);
  if (left <= 0) {
    button.disabled = false;
    button.textContent = label;
    return;
  }
  button.disabled = true;
  button.textContent = `${left}秒後に再試行できます`;
  const timer = setInterval(() => {
    left -= 1;
    if (left > 0) {
      button.textContent = `${left}秒後に再試行できます`;
      return;
    }
    clearInterval(timer);
    button.disabled = false;
    button.textContent = label;
  }, 1_000);
}

/** エラー表示そのものが失敗しても例外を外へ漏らさない（画面が読み込み中のまま固まるのを防ぐ）。 */
function showError(problem: DebtViewerError): void {
  const panel = document.querySelector<HTMLElement>("[data-error]");
  if (!panel) {
    alert(problem.message);
    return;
  }
  const title = panel.querySelector<HTMLElement>("[data-error-title]");
  if (title) title.textContent = problem.title;
  const message = panel.querySelector<HTMLElement>("[data-error-message]");
  if (message) message.textContent = problem.message;
  const reference = panel.querySelector<HTMLElement>("[data-error-reference]");
  if (reference) {
    reference.textContent = problem.requestId ? `問い合わせ番号：${problem.requestId}` : "";
    reference.hidden = !problem.requestId;
  }
  const retry = panel.querySelector<HTMLButtonElement>("[data-error-retry]");
  if (retry) {
    retry.hidden = !problem.retryable;
    retry.onclick = () => location.reload();
    if (problem.retryable) startRetryCountdown(retry, problem.retryAfter);
  }
  panel.hidden = false;
}

export async function initDebtViewer(): Promise<void> {
  // 別の共有URLを同じタブへ貼り直したとき、前の計画を表示したままにしない。
  window.addEventListener("hashchange", () => location.reload());
  try {
    const token = tokenFromFragment();
    if (!TOKEN.test(token)) {
      throw new DebtViewerError(
        "共有URLが正しくありません。途中で切れていないか確認し、URL全体をコピーして開いてください。",
        "共有リンクを確認できませんでした",
      );
    }
    const plan = normalizePlan(await post("/api/debt/share", { token }));
    render(plan, token);
    one<HTMLElement>("[data-content]").hidden = false;
  } catch (error) {
    document.querySelector<HTMLElement>("[data-content]")?.setAttribute("hidden", "");
    showError(describe(error, "返済計画の表示中に問題が発生しました。"));
  } finally {
    const loading = document.querySelector<HTMLElement>("[data-loading]");
    if (loading) loading.hidden = true;
    document.documentElement.classList.add("ui-ready");
  }
}
