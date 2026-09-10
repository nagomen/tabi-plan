import { icon } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import * as ExpenseStore from "../shared/expense-store";
import { escapeHtml } from "../shared/dom";
import { bindExpenseSplitForm } from "../shared/expense-form";
import { mdLabel } from "../shared/date";
import type { TripData } from "../shared/types";
import { getEditingExpenseId, hooks, isReadOnly, SAMPLE, setEditingExpenseId, state } from "./state";
import { qs, qsa, root } from "./dom";
import { planId } from "./plan-access";
import { todayISO } from "./days";
import { applyProfileDefaults, currentProfileName, expenseCurrencies, expenseParticipants } from "./profile";

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
  if (open) {
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
  if (!options.force && existingForm && existingForm.dataset.dirty === "true") return;
  const editingExpenseId = getEditingExpenseId();
  const editingRecord = editingExpenseId ? ExpenseStore.get(planId(), editingExpenseId) : undefined;
  const participants = expenseParticipants(data);
  if (editingExpenseId && !editingRecord) {
    mount.innerHTML = `<div class="tl-expense-empty">編集する費用が見つかりませんでした。台帳を更新してからもう一度開いてください。</div>`;
    return;
  }
  if (editingRecord) {
    const editingNames = [
      db.nameOf(editingRecord.row.payer_user_id),
      ...editingRecord.shares.map((share) => db.nameOf(share.user_id)),
    ].filter(Boolean);
    editingNames.forEach((name) => {
      if (!participants.includes(name)) participants.push(name);
    });
  }
  const currencyOptions = expenseCurrencies(data).map((code) => `<option>${escapeHtml(code)}</option>`).join("");
  const profileName = currentProfileName(participants);
  const payerOptions = participants.map((name) => `<option value="${escapeHtml(name)}" ${name === profileName ? "selected" : ""}>${escapeHtml(name)}</option>`).join("");
  const targetPicks = participants.map((name) => `
    <label class="tl-pick">
      <input type="checkbox" name="targets" value="${escapeHtml(name)}" checked>
      <span>${escapeHtml(name)}</span>
    </label>`).join("");
  const shareInputs = participants.map((name) => `
    <label class="tl-field">
      <span>${escapeHtml(name)}</span>
      <input type="number" name="share-${escapeHtml(name)}" data-share-name="${escapeHtml(name)}" min="0" step="1" inputmode="numeric" placeholder="0">
    </label>`).join("");

  mount.innerHTML = `
    <form class="tl-expense-form" data-expense-form-native>
      <div class="tl-expense-primary">
        <label class="tl-field tl-amount-field">
          <span>金額 <b class="tl-required-mark" aria-label="必須">*</b></span>
          <input type="number" name="amount" required min="1" step="1" inputmode="decimal" placeholder="0">
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
    fillExpenseForm(form, editingRecord, participants);
  }
  setupExpenseEntryHandlers(form, participants);
}

function fillExpenseForm(form: HTMLFormElement, entry: ExpenseStore.ExpenseEntry, participants: string[]): void {
  const record = {
    paidDate: entry.row.paid_on || "",
    payer: db.nameOf(entry.row.payer_user_id),
    category: ExpenseStore.CATEGORY_LABEL[entry.row.category],
    title: entry.row.title,
    amount: entry.row.amount_minor,
    currency: entry.row.currency,
    splitMode: ExpenseStore.SPLIT_LABEL[entry.row.split_method],
    paymentMethod: entry.row.payment_method ? ExpenseStore.PAYMENT_LABEL[entry.row.payment_method] : "",
    note: entry.row.note || "",
    targets: entry.shares.map((s) => db.nameOf(s.user_id)).filter(Boolean),
    individual: Object.fromEntries(entry.shares.map((s) => [db.nameOf(s.user_id), s.amount_base_minor])),
  };
  const setField = (name: string, value: string | number | undefined): void => {
    const field = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
    if (field) field.value = String(value ?? "");
  };
  setField("paidDate", record.paidDate || todayISO());
  setField("payer", record.payer);
  setField("category", record.category);
  setField("currency", record.currency || "JPY");
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
  participants.forEach((name) => {
    const input = qsa<HTMLInputElement>("[data-share-name]", form).find((item) => item.dataset.shareName === name);
    if (input) input.value = record.individual && record.individual[name] ? String(record.individual[name]) : "";
  });
}

function setupExpenseEntryHandlers(form: HTMLFormElement, participants: string[]): void {
  const status = qs<HTMLElement>("[data-expense-status]", form);
  const button = qs<HTMLButtonElement>("button[type='submit']", form);

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
  const updateEditorSummaries = (): void => {
    setSummary("[data-expense-summary-date]", mdLabel((field("paidDate") as HTMLInputElement).value || todayISO()));
    setSummary("[data-expense-summary-category]", (field("category") as HTMLSelectElement).value || "食費");
    setSummary("[data-expense-summary-currency]", (field("currency") as HTMLSelectElement).value || "JPY");
    setSummary("[data-expense-summary-payment]", (field("paymentMethod") as HTMLSelectElement).value || "カード");
    const note = ((field("note") as HTMLTextAreaElement).value || "").trim();
    setSummary("[data-expense-summary-note]", note ? "入力済み" : "任意");
  };

  const markChanged = (): void => {
    form.dataset.dirty = "true";
    updateEditorSummaries();
  };
  const split = bindExpenseSplitForm(form, participants, {
    onChange: markChanged,
    onInput: markChanged,
  });
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
    const targets = split.selectedNames();
    const individual = split.individualAmounts();
    const amount = split.amount();

    button.disabled = true;
    setStatus("保存中...", "");
    try {
      // フォームは表示名と日本語ラベルを持つので、user_id と列挙へ変換して保存する。
      const idOf = (name: string): string => {
        const user = db.findUserByName(name)
          || (!db.isEnabled() ? db.ensureUserLocal(name) : undefined);
        if (!user) throw new Error("旅行メンバー情報を再読み込みしてください");
        return user.id;
      };
      const custom: Record<string, number> = {};
      for (const [name, value] of Object.entries(individual)) custom[idOf(name)] = value;
      const paidOn = (field("paidDate") as HTMLInputElement).value || "";
      const payload: ExpenseStore.AddInput = {
        paidOn: paidOn || null,
        payerUserId: idOf((field("payer") as HTMLSelectElement).value),
        category: categoryFromLabel((field("category") as HTMLSelectElement).value),
        title: (field("title") as HTMLInputElement).value,
        amountMinor: amount,
        currency: (field("currency") as HTMLSelectElement).value,
        splitMethod: splitFromLabel(mode),
        paymentMethod: paymentFromLabel((field("paymentMethod") as HTMLSelectElement).value),
        note: (field("note") as HTMLTextAreaElement).value,
        // 「全員で等分」は、その費用の日に旅行へ在籍していたメンバーだけを対象にする
        // （途中合流/離脱を反映）。日付未指定なら全員。
        memberIds: TripPlans.memberIdsPresentOn(planId(), paidOn),
        selectedIds: targets.map(idOf),
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
