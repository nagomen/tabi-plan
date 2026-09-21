import { icon } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import * as ExpenseStore from "../shared/expense-store";
import { escapeHtml } from "../shared/dom";
import {
  currencyLabel, currencyStep, fxRateFromUnitRate, toMajor, toMinor, unitRateFromFxRate,
} from "../shared/currency";
import { bindExpenseSplitForm } from "../shared/expense-form";
import { mdLabel } from "../shared/date";
import type { TripData } from "../shared/types";
import { getEditingExpenseId, hooks, isReadOnly, SAMPLE, setEditingExpenseId, state } from "./state";
import { qs, qsa, root } from "./dom";
import { planId } from "./plan-access";
import { todayISO } from "./days";
import { applyProfileDefaults, currentProfileName, expenseCurrencies, expenseParticipants } from "./profile";

/** フォームの選択肢1つ。value は user_id で、label は見分けるための表示だけに使う。 */
interface FormMember {
  id: string;
  name: string;
  label: string;
}

/**
 * 参加者の表示名を user_id へ解決する。
 * 金額の割り当てを表示名で行うと、同名メンバーがいたときに別人へ付け替わるため、
 * 選択肢を組み立てる時点で ID に寄せて、名前はラベルとしてしか使わない。
 */
function participantMembers(names: string[], editing?: ExpenseStore.ExpenseEntry): FormMember[] {
  const byId = new Map<string, string>();
  const add = (id: string, name: string): void => {
    if (!id || byId.has(id)) return;
    byId.set(id, name || db.nameOf(id) || "名前未設定");
  };
  for (const name of names) {
    const user = db.findUserByName(name) || (!db.isEnabled() ? db.ensureUserLocal(name) : undefined);
    if (user) add(user.id, name);
  }
  // 編集中の費用に関わる人は、参加者一覧から漏れていても選択肢に残す。
  if (editing) {
    add(editing.row.payer_user_id, db.nameOf(editing.row.payer_user_id));
    for (const share of editing.shares) add(share.user_id, db.nameOf(share.user_id));
  }
  const entries = [...byId.entries()].map(([id, name]) => ({ id, name }));
  const numbering = new Map<string, number>();
  return entries.map((member) => {
    const duplicated = entries.filter((item) => item.name === member.name).length > 1;
    const order = (numbering.get(member.name) || 0) + 1;
    numbering.set(member.name, order);
    return { ...member, label: duplicated ? `${member.name} (${order})` : member.name };
  });
}

/** 計画の基準通貨。費用はこの通貨へ換算して割り勘・精算する。 */
function planBaseCurrency(): string {
  return (db.planById(planId())?.base_currency || "JPY").toUpperCase();
}

// フォームは日本語ラベルを value に持つ。列挙へ寄せる変換をここに集約する。
function categoryFromLabel(label: string): ExpenseStore.ExpenseCategory {
  return (ExpenseStore.CATEGORIES.find((c) => ExpenseStore.CATEGORY_LABEL[c] === label) || "other");
}
function splitFromLabel(label: string): ExpenseStore.SplitMethod {
  return (ExpenseStore.SPLIT_METHODS.find((m) => ExpenseStore.SPLIT_LABEL[m] === label) || "equal_all");
}
function paymentFromLabel(label: string): ExpenseStore.PaymentMethod | null {
  return ExpenseStore.PAYMENT_METHODS.find((m) => ExpenseStore.PAYMENT_LABEL[m] === label) || null;
}

/** 費用入力ボトムシートの開閉。入力フォームは [data-expense-entry] にマウント済み。 */
export function setExpenseSheet(open: boolean): void {
  const sheet = root.querySelector<HTMLElement>("[data-expense-sheet]");
  if (!sheet) return;
  if (!open) {
    setEditingExpenseId(null);
    renderExpenseEntry(state.data || SAMPLE, { force: true });
  }
  const title = sheet.querySelector<HTMLElement>("[data-expense-sheet-title]");
  if (title) title.textContent = getEditingExpenseId() ? "費用を編集" : "費用を追加";
  const panel = sheet.querySelector<HTMLElement>("[role='dialog']");
  if (panel) panel.setAttribute("aria-label", getEditingExpenseId() ? "費用を編集" : "費用を追加");
  sheet.hidden = !open;
  document.documentElement.style.overflow = open ? "hidden" : "";
  // タッチ端末で自動フォーカスすると、開いた直後にキーボードが出て画面が飛ぶ。
  // 自分で入力欄を選ぶほうが落ち着くので、フォーカスはポインタのある端末だけにする。
  const pointerDevice = typeof window.matchMedia === "function"
    && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (open && pointerDevice) {
    const first = sheet.querySelector<HTMLInputElement | HTMLSelectElement>(
      "input:not([type=hidden]):not([type=file]), select",
    );
    if (first) setTimeout(() => first.focus(), 60);
  }
}

export function renderExpenseEntry(data: TripData, options: { force?: boolean } = {}): void {
  const mount = root.querySelector<HTMLElement>("[data-expense-entry]");
  if (!mount) return;
  const existingForm = mount.querySelector<HTMLFormElement>("[data-expense-form-native]");
  // 入力中の作り直しは、入力内容だけでなくフォーカスとキーボードも失わせる。
  // 触り始めた時点（dirty）と、まだ何も打っていないが触っている時点の両方で作り直さない。
  const editing = existingForm
    && (existingForm.dataset.dirty === "true" || existingForm.contains(document.activeElement));
  if (!options.force && editing) return;
  const editingExpenseId = getEditingExpenseId();
  const editingRecord = editingExpenseId ? ExpenseStore.get(planId(), editingExpenseId) : undefined;
  const participants = expenseParticipants(data);
  if (editingExpenseId && !editingRecord) {
    mount.innerHTML = `<div class="tl-expense-empty">編集する費用が見つかりませんでした。台帳を更新してからもう一度開いてください。</div>`;
    return;
  }
  const members = participantMembers(participants, editingRecord);
  if (!members.length) {
    mount.innerHTML = `<div class="tl-expense-empty">旅行メンバーを読み込めませんでした。画面を再読み込みしてからお試しください。</div>`;
    return;
  }
  const baseCurrency = planBaseCurrency();
  // value は ISO コードのまま。略称だけでは伝わらないので、表示には国旗を添える。
  const currencyOptions = expenseCurrencies(data)
    .map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(currencyLabel(code))}</option>`)
    .join("");
  const profileName = currentProfileName(participants);
  // value は user_id。表示名は同名メンバーがいると誰の負担か決められないため、ラベルにだけ使う。
  const payerOptions = members.map((member) => `<option value="${escapeHtml(member.id)}" ${member.name === profileName ? "selected" : ""}>${escapeHtml(member.label)}</option>`).join("");
  const targetPicks = members.map((member) => `
    <label class="tl-pick">
      <input type="checkbox" name="targets" value="${escapeHtml(member.id)}" checked>
      <span>${escapeHtml(member.label)}</span>
    </label>`).join("");
  const shareInputs = members.map((member) => `
    <label class="tl-field">
      <span>${escapeHtml(member.label)}</span>
      <input type="number" name="share-${escapeHtml(member.id)}" data-share-id="${escapeHtml(member.id)}" min="0" step="${currencyStep(baseCurrency)}" inputmode="decimal" placeholder="0">
    </label>`).join("");

  mount.innerHTML = `
    <form class="tl-expense-form" data-expense-form-native>
      <div class="tl-expense-primary">
        <label class="tl-field tl-amount-field">
          <span>金額 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="number" name="amount" required min="0" step="${currencyStep(baseCurrency)}" inputmode="decimal" placeholder="0">
        </label>
        <label class="tl-field wide">
          <span>内容 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="text" name="title" required placeholder="例: 空港からホテルまでのタクシー">
        </label>
        <label class="tl-field">
          <span>支払者 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <select name="payer" required>${payerOptions}</select>
        </label>
      </div>

      <div class="tl-expense-editors" aria-label="費用の詳細">
        <details class="tl-expense-editor">
          <summary>${icon("calendarDays")}<span>支払日</span><b data-expense-summary-date></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>支払日 <b class="tl-required-mark" aria-label="必須">*</b></span>
            <input type="date" name="paidDate" required>
          </label>
        </details>
        <details class="tl-expense-editor">
          <summary>${icon("listBullet")}<span>カテゴリ</span><b data-expense-summary-category></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>カテゴリ <b class="tl-required-mark" aria-label="必須">*</b></span>
            <select name="category" required>
              <option>食費</option>
              <option>交通</option>
              <option>宿泊</option>
              <option>観光</option>
              <option>通信</option>
              <option>その他</option>
            </select>
          </label>
        </details>
        <details class="tl-expense-editor">
          <summary>${icon("currencyYen")}<span>通貨</span><b data-expense-summary-currency></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>通貨 <b class="tl-required-mark" aria-label="必須">*</b></span>
            <select name="currency" required>${currencyOptions}</select>
          </label>
          <label class="tl-field" data-fx-field>
            <span>為替レート <b class="tl-required-mark" aria-label="必須">*</b></span>
            <input type="number" name="fxRate" min="0" step="0.0001" inputmode="decimal" placeholder="0">
            <small data-fx-hint></small>
          </label>
        </details>
      </div>

      <div class="tl-split">
        <span class="tl-split-label">精算方法 <b class="tl-required-mark" aria-label="必須">*</b></span>
        <div class="tl-segments">
          <label class="tl-segment"><input type="radio" name="splitMode" value="全員で等分" required checked><span>全員で等分</span></label>
          <label class="tl-segment"><input type="radio" name="splitMode" value="選んだ人だけで等分" required><span>選んだ人だけ</span></label>
          <label class="tl-segment"><input type="radio" name="splitMode" value="個別金額を入力" required><span>個別金額</span></label>
          <label class="tl-segment"><input type="radio" name="splitMode" value="精算不要" required><span>精算不要</span></label>
        </div>
      </div>

      <div class="tl-split-detail" data-selected-detail>
        <span class="tl-split-label">割り勘する人</span>
        <div class="tl-participant-picks">${targetPicks}</div>
      </div>

      <div class="tl-split-detail" data-individual-detail>
        <span class="tl-split-label">各自の負担額</span>
        <div class="tl-individual-grid">${shareInputs}</div>
        <div class="tl-share-total" data-share-total>合計 ¥0</div>
      </div>

      <div class="tl-expense-editors" aria-label="任意項目">
        <details class="tl-expense-editor">
          <summary>${icon("banknotes")}<span>支払方法</span><b data-expense-summary-payment></b>${icon("chevronDown")}</summary>
          <label class="tl-field">
            <span>支払方法</span>
            <select name="paymentMethod">
              <option>カード</option>
              <option>現金</option>
              <option>送金</option>
              <option>その他</option>
            </select>
          </label>
        </details>
        <details class="tl-expense-editor">
          <summary>${icon("pencilSquare")}<span>メモ</span><b data-expense-summary-note>任意</b>${icon("chevronDown")}</summary>
          <label class="tl-field wide">
            <span>メモ</span>
            <textarea name="note" placeholder="任意。為替メモや補足があれば入力"></textarea>
          </label>
        </details>
      </div>

      <div class="tl-expense-submit">
        <div class="tl-expense-status" data-expense-status aria-live="polite"></div>
        <button type="submit">${editingRecord ? "更新" : "保存"}</button>
      </div>
    </form>`;

  const form = qs<HTMLFormElement>("[data-expense-form-native]", mount);
  (form.elements.namedItem("paidDate") as HTMLInputElement).value = todayISO();
  applyProfileDefaults(form, participants);
  if (editingRecord) {
    fillExpenseForm(form, editingRecord, members, baseCurrency);
  }
  setupExpenseEntryHandlers(form, members, baseCurrency);
}

function fillExpenseForm(
  form: HTMLFormElement,
  entry: ExpenseStore.ExpenseEntry,
  members: FormMember[],
  baseCurrency: string,
): void {
  const currency = (entry.row.currency || baseCurrency).toUpperCase();
  const rate = entry.row.fx_rate > 0 ? entry.row.fx_rate : 1;
  const record = {
    paidDate: entry.row.paid_on || "",
    payer: entry.row.payer_user_id,
    category: ExpenseStore.CATEGORY_LABEL[entry.row.category],
    title: entry.row.title,
    // 保存は最小単位。入力欄は人が読む単位なので戻してから表示する。
    amount: toMajor(entry.row.amount_minor, currency),
    currency,
    fxRate: currency === baseCurrency ? "" : unitRateFromFxRate(rate, currency, baseCurrency),
    splitMode: ExpenseStore.SPLIT_LABEL[entry.row.split_method],
    paymentMethod: entry.row.payment_method ? ExpenseStore.PAYMENT_LABEL[entry.row.payment_method] : "",
    note: entry.row.note || "",
    targets: entry.shares.map((s) => s.user_id).filter(Boolean),
    // 負担額は基準通貨で保存されている。個別金額の入力欄は費用の通貨なので割り戻す。
    individual: Object.fromEntries(
      entry.shares.map((s) => [s.user_id, toMajor(Math.round(s.amount_base_minor / rate), currency)]),
    ),
  };
  const setField = (name: string, value: string | number | undefined): void => {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (field) field.value = String(value ?? "");
  };
  setField("paidDate", record.paidDate || todayISO());
  setField("payer", record.payer);
  setField("category", record.category);
  setField("currency", record.currency);
  setField("fxRate", record.fxRate);
  setField("title", record.title);
  setField("amount", record.amount);
  setField("paymentMethod", record.paymentMethod);
  setField("note", record.note);
  qsa<HTMLInputElement>("input[name='splitMode']", form).forEach((input) => {
    input.checked = input.value === record.splitMode;
  });
  qsa<HTMLInputElement>("input[name='targets']", form).forEach((input) => {
    input.checked = record.targets && record.targets.length ? record.targets.includes(input.value) : true;
  });
  members.forEach((member) => {
    const input = qsa<HTMLInputElement>("[data-share-id]", form).find((item) => item.dataset.shareId === member.id);
    if (input) input.value = record.individual[member.id] ? String(record.individual[member.id]) : "";
  });
}

function setupExpenseEntryHandlers(form: HTMLFormElement, members: FormMember[], baseCurrency: string): void {
  const status = qs<HTMLElement>("[data-expense-status]", form);
  const button = qs<HTMLButtonElement>("button[type='submit']", form);
  const participants = members.map((member) => member.name);

  const field = (name: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

  const setStatus = (message: string, type: "error" | "ok" | ""): void => {
    status.textContent = message || "";
    status.classList.toggle("is-error", type === "error");
    status.classList.toggle("is-ok", type === "ok");
  };
  const setSummary = (selector: string, value: string): void => {
    const node = form.querySelector<HTMLElement>(selector);
    if (node) node.textContent = value;
  };
  const selectedCurrency = (): string => ((field("currency") as HTMLSelectElement).value || baseCurrency).toUpperCase();
  const fxField = form.querySelector<HTMLElement>("[data-fx-field]");
  const fxInput = field("fxRate") as HTMLInputElement;

  /**
   * 基準通貨以外を選んだときだけレート欄を出す。
   * レートが無いと外貨がそのまま基準通貨の額として保存され、合計も精算も狂う。
   */
  // 入力のたびに呼ばれるので、通貨が変わった瞬間だけ開閉に触れる（打鍵中に画面を動かさない）。
  let appliedCurrency = "";
  const applyCurrency = (): void => {
    const currency = selectedCurrency();
    const foreign = currency !== baseCurrency;
    const switched = currency !== appliedCurrency;
    appliedCurrency = currency;
    if (fxField) fxField.style.display = foreign ? "" : "none";
    fxInput.required = foreign;
    if (!foreign) fxInput.value = "";
    // レートは必須なので、外貨へ切り替えた時点で閉じたアコーディオンの中に隠れたままにしない。
    const editor = fxField?.closest("details");
    if (editor && switched && foreign && !fxInput.value) editor.open = true;
    const hint = form.querySelector<HTMLElement>("[data-fx-hint]");
    if (hint) hint.textContent = foreign ? `1 ${currency} = ? ${baseCurrency}` : "";
    const amountInput = field("amount") as HTMLInputElement;
    amountInput.step = currencyStep(currency);
    qsa<HTMLInputElement>("[data-share-id]", form).forEach((input) => { input.step = currencyStep(currency); });
  };

  const updateEditorSummaries = (): void => {
    setSummary("[data-expense-summary-date]", mdLabel((field("paidDate") as HTMLInputElement).value || todayISO()));
    setSummary("[data-expense-summary-category]", (field("category") as HTMLSelectElement).value || "食費");
    setSummary("[data-expense-summary-currency]", currencyLabel(selectedCurrency()));
    setSummary("[data-expense-summary-payment]", (field("paymentMethod") as HTMLSelectElement).value || "カード");
    const note = ((field("note") as HTMLTextAreaElement).value || "").trim();
    setSummary("[data-expense-summary-note]", note ? "入力済み" : "任意");
  };

  const markChanged = (): void => {
    form.dataset.dirty = "true";
    applyCurrency();
    updateEditorSummaries();
  };
  const split = bindExpenseSplitForm(form, members, {
    onChange: markChanged,
    onInput: markChanged,
  });
  applyCurrency();
  updateEditorSummaries();

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isReadOnly()) {
      setStatus("閲覧のみの計画では費用を追加できません。", "error");
      return;
    }
    const validation = split.validationMessage();
    if (validation) { setStatus(validation, "error"); return; }
    const mode = split.mode();
    const targets = split.selectedIds();
    const individual = split.individualAmounts();
    const amount = split.amount();
    const currency = selectedCurrency();
    const splitMethod = splitFromLabel(mode);

    // 外貨はレートが無いと基準通貨へ換算できない。1:1 で保存すると金額が別物になる。
    const unitRate = Number(fxInput.value);
    const fxRate = currency === baseCurrency ? 1 : fxRateFromUnitRate(unitRate, currency, baseCurrency);
    if (!fxRate) {
      setStatus(`1 ${currency} が何 ${baseCurrency} かを入力してください。`, "error");
      return;
    }
    const paidOn = (field("paidDate") as HTMLInputElement).value || "";
    // 「全員で等分」はその費用の日に在籍していたメンバーだけを対象にする（途中合流/離脱を反映）。
    // 旅行期間の外に払った前払い分は誰の在籍期間にも入らないので、その場合は全員へ戻す。
    const presentIds = TripPlans.memberIdsPresentOn(planId(), paidOn);
    const memberIds = presentIds.length ? presentIds : TripPlans.memberIdsPresentOn(planId(), "");
    if (splitMethod === "equal_all" && !memberIds.length) {
      setStatus("割り勘の対象になるメンバーがいません。メンバーを確認してください。", "error");
      return;
    }

    button.disabled = true;
    setStatus("保存中...", "");
    try {
      // フォームの value は user_id。金額は入力単位（major）から保存単位（minor）へ寄せる。
      const custom = Object.fromEntries(
        Object.entries(individual).map(([userId, value]) => [userId, toMinor(value, currency)]),
      );
      const payload: ExpenseStore.AddInput = {
        paidOn: paidOn || null,
        payerUserId: (field("payer") as HTMLSelectElement).value,
        category: categoryFromLabel((field("category") as HTMLSelectElement).value),
        title: (field("title") as HTMLInputElement).value,
        amountMinor: toMinor(amount, currency),
        currency,
        fxRate,
        splitMethod,
        paymentMethod: paymentFromLabel((field("paymentMethod") as HTMLSelectElement).value),
        note: (field("note") as HTMLTextAreaElement).value,
        memberIds,
        selectedIds: targets,
        customAmounts: custom,
      };
      const editingExpenseId = getEditingExpenseId();
      if (editingExpenseId) {
        await ExpenseStore.update(editingExpenseId, payload);
      } else {
        await ExpenseStore.add(planId(), payload);
      }
      form.reset();
      form.dataset.dirty = "false";
      setEditingExpenseId(null);
      (field("paidDate") as HTMLInputElement).value = todayISO();
      applyProfileDefaults(form, participants);
      qsa<HTMLInputElement>("input[name='targets']", form).forEach((input) => { input.checked = true; });
      applyCurrency();
      split.refresh();
      hooks.renderBase();
      hooks.renderActive();
      setExpenseSheet(false);
      const nextStatus = root.querySelector<HTMLElement>("[data-expense-status]");
      if (nextStatus) {
        nextStatus.textContent = "保存しました。費用を更新済みです。";
        nextStatus.classList.add("is-ok");
      }
    } catch (error) {
      setStatus((error as Error).message || "保存に失敗しました。", "error");
    } finally {
      button.disabled = false;
    }
  });
}
