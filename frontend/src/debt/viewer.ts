import { icon, type IconName } from "../shared/icons";
import { DebtViewerError, post } from "./api";
import { renderFundingPlan, renderScenarioLeftover } from "./funding";
import { initDebtNav } from "./nav";
import {
  normalizePdf, normalizePlan,
  type DebtDocument, type DebtPlan, type Installment, type RepaymentScenario,
} from "./normalize";

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const weekday = ["日", "月", "火", "水", "木", "金", "土"];
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function yenRange(minimum: number, maximum: number): string {
  return minimum === maximum ? yen.format(maximum) : `${yen.format(minimum)}〜${yen.format(maximum)}`;
}

function one<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  // HTMLとJSの版がずれた（古いキャッシュ）ときに起きる。利用者には再読み込みを案内する。
  if (!node) throw new Error(`画面要素が見つかりません: ${selector}`);
  return node;
}

function accessFromFragment(): { token: string; manage: boolean } {
  const fragment = location.hash.slice(1);
  try {
    const params = new URLSearchParams(fragment);
    const managementToken = params.get("manage");
    const token = managementToken || params.get("token") || fragment;
    return { token: decodeURIComponent(token).trim(), manage: Boolean(managementToken) };
  } catch {
    // %の後ろが欠けた貼り付けなど。形式チェックで「URLが正しくない」と案内する。
    return { token: "", manage: false };
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

interface PaymentState {
  label: string;
  className: string;
  icon: IconName;
}

function statusFor(item: Installment, today: string): PaymentState {
  if (item.amount_yen === 0) return { label: "返済猶予", className: "is-deferred", icon: "pauseCircle" };
  if (item.paid_at) return { label: "返済済み", className: "is-paid", icon: "checkCircle" };
  if (item.due_date < today) return { label: "期日超過", className: "is-overdue", icon: "exclamationTriangle" };
  if (item.due_date === today) return { label: "本日期日", className: "is-today", icon: "calendarDays" };
  return { label: "予定", className: "is-pending", icon: "clock" };
}

/** 状態は heroicon と文字で示す（アイコンだけだと意味を取り違えやすいので文字も残す）。 */
function paintState(node: HTMLElement, state: PaymentState): void {
  node.className = `dn-state ${state.className}`;
  node.innerHTML = icon(state.icon, { strokeWidth: 1.8 });
  const label = document.createElement("span");
  label.textContent = state.label;
  node.append(label);
}

function renderSchedule(schedule: Installment[]): void {
  const tbody = one<HTMLTableSectionElement>("[data-schedule]");
  // 再試行で描き直しても行が二重にならないよう、毎回空にしてから積む。
  tbody.replaceChildren();
  const today = todayInJapan();
  let cumulative = 0;
  for (const item of schedule) {
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
    paintState(badge, status);
    stateCell.append(badge);
    row.append(stateCell);
    tbody.append(row);
  }
  if (!schedule.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.textContent = "返済予定はまだ登録されていません。";
    row.append(cell);
    tbody.append(row);
  }
  const paymentCount = schedule.filter((item) => item.amount_yen > 0).length;
  const deferredCount = schedule.length - paymentCount;
  setText("[data-schedule-count]", deferredCount ? `全${paymentCount}回返済・${deferredCount}か月猶予` : `全${paymentCount}回`);
}

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

function renderScheduleOverview(schedule: Installment[]): void {
  const payments = schedule.filter((item) => item.amount_yen > 0);
  const paid = payments.filter((item) => Boolean(item.paid_at)).length;
  const next = payments.find((item) => !item.paid_at);
  setText("[data-count-label]", `残り ${payments.length - paid}回`);
  setText("[data-completion]", displayDate(schedule.at(-1)?.due_date || ""));

  const nextStatus = one<HTMLElement>("[data-next-status]");
  if (next) {
    setText("[data-next-date]", displayDate(next.due_date));
    setText("[data-next-amount]", yen.format(next.amount_yen));
    paintState(nextStatus, statusFor(next, todayInJapan()));
  } else if (!payments.length) {
    setText("[data-next-date]", "未定");
    setText("[data-next-amount]", "—");
    paintState(nextStatus, { label: "返済予定未登録", className: "is-pending", icon: "clock" });
  } else {
    setText("[data-next-date]", "完済");
    setText("[data-next-amount]", yen.format(0));
    paintState(nextStatus, { label: "すべて返済済み", className: "is-paid", icon: "checkCircle" });
  }
  renderSchedule(schedule);
}

function renderPlanSwitch(plan: DebtPlan): void {
  const scenarios = plan.document.repayment_scenarios;
  if (!scenarios.length) {
    renderScheduleOverview(plan.schedule);
    return;
  }

  const tabs = one<HTMLElement>("[data-plan-tabs]");
  tabs.replaceChildren();
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (scenario: RepaymentScenario): void => {
    for (const [id, button] of buttons) {
      const active = id === scenario.id;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    setText("[data-selected-income]", yenRange(scenario.net_income_min_yen, scenario.net_income_yen));
    setText("[data-selected-repayment]", scenario.repayment_summary || yen.format(scenario.monthly_repayment_yen));
    renderScenarioLeftover(one<HTMLElement>("[data-selected-buffer]"), scenario);
    setText("[data-selected-completion]", displayDate(scenario.completion_date));
    setText("[data-selected-note]", scenario.note);
    renderScheduleOverview(scheduleForScenario(plan, scenario));
  };

  scenarios.forEach((scenario, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dn-plan-tab";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", "false");
    button.textContent = scenario.title;
    button.onclick = () => select(scenario);
    button.onkeydown = (event) => {
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % scenarios.length;
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + scenarios.length) % scenarios.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = scenarios.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      const nextScenario = scenarios[nextIndex];
      select(nextScenario);
      buttons.get(nextScenario.id)?.focus();
    };
    buttons.set(scenario.id, button);
    tabs.append(button);
  });
  one<HTMLElement>("[data-schedule-plans]").hidden = false;
  select(scenarios.find((scenario) => scenario.id === "repeat-year") || scenarios[0]);
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

async function downloadPdf(button: HTMLButtonElement, token: string, manage: boolean): Promise<void> {
  if (button.disabled) return;
  const label = button.querySelector<HTMLElement>("[data-download-label]");
  const original = label?.textContent || button.textContent || "原本PDFをダウンロード";
  const setLabel = (value: string): void => {
    if (label) label.textContent = value;
    else button.textContent = value;
  };
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setLabel("PDFを準備中…");
  try {
    const pdf = normalizePdf(await post(manage ? "/api/debt/manage/pdf" : "/api/debt/share/pdf", { token }));
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
    button.removeAttribute("aria-busy");
    setLabel(original);
  }
}

function renderManagement(plan: DebtPlan, token: string): void {
  const panel = one<HTMLElement>("[data-payment-action]");
  const button = one<HTMLButtonElement>("[data-mark-paid]");
  const feedback = one<HTMLElement>("[data-payment-feedback]");
  const next = plan.schedule.find((item) => item.amount_yen > 0 && !item.paid_at);
  panel.hidden = false;
  one<HTMLElement>("[data-access-label]").textContent = "債務者用";
  one<HTMLElement>("[data-access-note]").textContent = "氏名・メールアドレスは表示されません。この債務者専用URLは第三者へ転送しないでください。";
  feedback.textContent = "";
  if (!next) {
    setText("[data-payment-copy]", "すべての返済が記録されています。");
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.disabled = false;
  setText("[data-payment-copy]", `${displayDate(next.due_date)}・${yen.format(next.amount_yen)}の返済を記録し、貸主へメールで知らせます。`);
  button.onclick = async () => {
    if (!confirm(`${displayDate(next.due_date)}の${yen.format(next.amount_yen)}を振り込み済みとして記録しますか？`)) return;
    button.disabled = true;
    feedback.textContent = "返済を記録しています…";
    try {
      const result = await post("/api/debt/manage/paid", { token, due_date: next.due_date });
      const body = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
      const updated = normalizePlan(body.plan);
      render(updated, token, true);
      one<HTMLElement>("[data-payment-feedback]").textContent = body.notification === "sent"
        ? "返済を記録し、貸主へメールを送信しました。"
        : "返済を記録しました。貸主へのメールは送信待ちです。";
    } catch (error) {
      const problem = describe(error, "返済を記録できませんでした。");
      feedback.textContent = problem.message;
      button.disabled = false;
    }
  };
}

function render(plan: DebtPlan, token: string, manage: boolean): void {
  const remaining = Math.max(0, plan.total_yen - plan.paid_yen);
  const progress = plan.total_yen ? Math.min(100, Math.round(plan.paid_yen / plan.total_yen * 100)) : 0;
  setText("[data-remaining]", yen.format(remaining));
  setText("[data-progress-label]", `${progress}% 返済済み`);
  one<HTMLElement>("[data-progress]").style.width = `${progress}%`;
  setText("[data-principal]", yen.format(plan.principal_yen));
  setText("[data-interest]", yen.format(plan.interest_yen));
  setText("[data-total]", yen.format(plan.total_yen));
  setText("[data-updated]", displayDate(plan.updated_at.slice(0, 10)));
  renderDocument(plan.document);
  renderPlanSwitch(plan);
  if (manage) renderManagement(plan, token);

  // onclick への代入なので、描き直しても処理が二重登録されない。
  const download = one<HTMLButtonElement>("[data-download]");
  download.onclick = () => { void downloadPdf(download, token, manage); };
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
    const access = accessFromFragment();
    const { token } = access;
    if (!TOKEN.test(token)) {
      throw new DebtViewerError(
        "共有URLが正しくありません。途中で切れていないか確認し、URL全体をコピーして開いてください。",
        "共有リンクを確認できませんでした",
      );
    }
    const plan = normalizePlan(await post(access.manage ? "/api/debt/manage" : "/api/debt/share", { token }));
    render(plan, token, access.manage);
    one<HTMLElement>("[data-content]").hidden = false;
    // 目次は表示中のセクションから作るので、本文を出したあとに組み立てる。
    initDebtNav();
  } catch (error) {
    document.querySelector<HTMLElement>("[data-content]")?.setAttribute("hidden", "");
    showError(describe(error, "返済計画の表示中に問題が発生しました。"));
  } finally {
    const loading = document.querySelector<HTMLElement>("[data-loading]");
    if (loading) loading.hidden = true;
    document.documentElement.classList.add("ui-ready");
  }
}
