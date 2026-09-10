import { icon, type IconName } from "../shared/icons";
import { currentUserId } from "../shared/identity";
import * as db from "../shared/db";
import * as ExpenseStore from "../shared/expense-store";
import { escapeHtml, errorMessage } from "../shared/dom";
import { formatYen } from "./api-data-source";
import { getPayLink, isPayUrl } from "../shared/payment-links";
import { mdLabel } from "../shared/date";
import type { Settlement, SettlementTransfer, ExpenseDetail } from "../shared/types";
import { hooks, isReadOnly, SAMPLE, setEditingExpenseId, state } from "./state";
import { qsa, root, subhead } from "./dom";
import { isEditableLocalPlan, memberIds, planId } from "./plan-access";
import { renderExpenseEntry, setExpenseSheet } from "./expense-entry";

/** スマホの費用タブ。既定は精算する金額。PC では両方出すので使わない。 */
let moneyTab: "settle" | "details" = "settle";

export function applyMoneyTab(next?: "settle" | "details"): void {
  if (next) moneyTab = next;
  qsa<HTMLElement>("[data-money-tab]").forEach((tab) => {
    const active = tab.dataset.moneyTab === moneyTab;
    tab.setAttribute("aria-selected", String(active));
    tab.classList.toggle("is-active", active);
  });
  qsa<HTMLElement>("[data-money-panel]").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.moneyPanel === moneyTab);
  });
}
/** 費用と精算から Settlement を組み立てる。 */
export function localSettlement(): Settlement {
  return ExpenseStore.computeSettlement(planId(), memberIds(), currentUserId());
}

// ---- 費用・精算描画 -----------------------------------------------------

export function renderTransfers(settlement: Settlement): void {
  const mount = root.querySelector<HTMLElement>("[data-transfers]");
  if (!mount) return;
  const transfers = settlement.transfers || [];
  const history = settlement.settlementHistory || [];
  const historyHtml = history.length ? `
    <div class="tl-settlement-history">
      ${subhead("checkCircle", "精算履歴", `${history.length}件`)}
      ${history.map((item) => `
        <div class="tl-settlement-history-row">
          <span>${escapeHtml(mdLabel(item.date || ""))}</span>
          <b>${escapeHtml(item.from)} → ${escapeHtml(item.to)}</b>
          <strong>${escapeHtml(item.amountLabel)}</strong>
          ${isEditableLocalPlan() && item.id ? `<button type="button" class="tl-icon-action" data-settlement-delete="${escapeHtml(item.id)}" aria-label="この精算記録を取り消す" title="精算記録を取り消す">${icon("xMark")}</button>` : ""}
        </div>
      `).join("")}
    </div>` : "";
  if (!transfers.length) {
    mount.innerHTML = `${subhead("banknotes", "精算する金額")}<div class="tl-transfer-row"><span>現時点で精算する支払いはありません</span><b>¥0</b></div>${historyHtml}<div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
    setupSettlementCompleteHandlers(mount);
    return;
  }
  mount.innerHTML = subhead("banknotes", "精算する金額", `${transfers.length}件`) + transfers.map((transfer: SettlementTransfer & { completedLabel?: string }) =>
    `<div class="tl-transfer-row">
      <span>${escapeHtml(transfer.from)} → ${escapeHtml(transfer.to)}</span>
      <div class="tl-transfer-act">
        <b>${escapeHtml(transfer.amountLabel || "")}</b>
        <button type="button" class="tl-icon-action tl-paypay" data-paypay data-to="${escapeHtml(transfer.to)}" data-to-id="${escapeHtml(transfer.toId || "")}" data-amount="${Number(transfer.amount || 0)}" aria-label="${escapeHtml(transfer.to)}へPayPayで送る" title="PayPayで送る">${icon("paperAirplane")}</button>
        <button type="button" class="tl-icon-action" data-settlement-complete data-from="${escapeHtml(transfer.from)}" data-to="${escapeHtml(transfer.to)}" data-from-id="${escapeHtml(transfer.fromId || "")}" data-to-id="${escapeHtml(transfer.toId || "")}" data-amount="${Number(transfer.amount || 0)}" aria-label="${escapeHtml(transfer.from)}から${escapeHtml(transfer.to)}への精算を完了" title="精算完了">${icon("checkCircle")}</button>
      </div>
      ${transfer.completedLabel ? `<small>完了済み ${escapeHtml(transfer.completedLabel)} を差し引き済み</small>` : ""}
    </div>`,
  ).join("") + historyHtml + `<div class="tl-expense-status" data-settlement-status aria-live="polite"></div>`;
  setupSettlementCompleteHandlers(mount);
}

function confirmTransferAction(options: {
  tone?: "paypay" | "complete" | "danger";
  iconName: IconName;
  title: string;
  message: string;
  confirmLabel: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const existing = document.querySelector(".tl-confirm-modal");
    if (existing) existing.remove();
    const modal = document.createElement("div");
    modal.className = `tl-confirm-modal ${options.tone ? `is-${options.tone}` : ""}`;
    modal.innerHTML = `
      <div class="tl-confirm-scrim" data-confirm-cancel></div>
      <section class="tl-confirm-card" role="dialog" aria-modal="true" aria-labelledby="transferConfirmTitle">
        <div class="tl-confirm-icon">${icon(options.iconName)}</div>
        <div class="tl-confirm-copy">
          <h2 id="transferConfirmTitle">${escapeHtml(options.title)}</h2>
          <p>${escapeHtml(options.message)}</p>
        </div>
        <div class="tl-confirm-actions">
          <button type="button" class="tl-confirm-cancel" data-confirm-cancel>キャンセル</button>
          <button type="button" class="tl-confirm-ok" data-confirm-ok>${escapeHtml(options.confirmLabel)}</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    const finish = (ok: boolean): void => {
      document.documentElement.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeydown);
      modal.remove();
      resolve(ok);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") finish(false);
    };
    modal.querySelectorAll<HTMLElement>("[data-confirm-cancel]").forEach((el) => {
      el.addEventListener("click", () => finish(false));
    });
    modal.querySelector<HTMLButtonElement>("[data-confirm-ok]")?.addEventListener("click", () => finish(true));
    document.addEventListener("keydown", onKeydown);
    setTimeout(() => modal.querySelector<HTMLButtonElement>("[data-confirm-ok]")?.focus(), 30);
  });
}

/** PayPay 受取リンクを開き、金額をクリップボードへコピーして送金を補助する。 */
async function payViaPayPay(to: string, toId: string, amount: number, status: HTMLElement | null): Promise<void> {
  const link = getPayLink(toId);
  let copied = false;
  try {
    await navigator.clipboard.writeText(String(Math.round(amount)));
    copied = true;
  } catch {
    /* クリップボード不可でも続行 */
  }
  const setStatus = (text: string): void => {
    if (status) {
      status.textContent = text;
      status.classList.remove("is-error");
    }
  };
  if (link?.paypay && isPayUrl(link.paypay)) {
    window.open(link.paypay, "_blank", "noopener");
    setStatus(
      `${to} の PayPay を開きました。${copied ? `金額 ${formatYen(amount)} をコピー済み。貼り付けて送金してください。` : `金額は ${formatYen(amount)} です。`}`,
    );
  } else if (link?.paypay) {
    setStatus(`${to} の PayPay ID: ${link.paypay}（金額 ${formatYen(amount)}${copied ? " をコピー済み" : ""}）`);
  } else {
    setStatus(`${to} の受取リンクが未登録です。マイページ → 送金 で登録できます。`);
  }
}

function setupSettlementCompleteHandlers(mount: HTMLElement): void {
  const status = mount.querySelector<HTMLElement>("[data-settlement-status]");
  mount.querySelectorAll<HTMLButtonElement>("[data-paypay]").forEach((button) => {
    button.addEventListener("click", async () => {
      const to = button.dataset.to || "";
      const toId = button.dataset.toId || "";
      const amount = Number(button.dataset.amount || 0);
      if (!to || !toId || !amount) return;
      const ok = await confirmTransferAction({
        tone: "paypay",
        iconName: "paperAirplane",
        title: "PayPayで送金しますか",
        message: `${to} に ${formatYen(amount)} を送る準備をします。金額をコピーしてPayPayを開きます。`,
        confirmLabel: "PayPayを開く",
      });
      if (!ok) return;
      void payViaPayPay(to, toId, amount, status);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-settlement-complete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const from = button.dataset.from || "";
      const to = button.dataset.to || "";
      const amount = Number(button.dataset.amount || 0);
      if (!from || !to || !amount) return;
      const ok = await confirmTransferAction({
        tone: "complete",
        iconName: "checkCircle",
        title: "精算完了マークをつけますか",
        message: `${from} から ${to} への ${formatYen(amount)} の精算を完了として記録します。実際の送金が済んでいる場合だけ進めてください。`,
        confirmLabel: "完了にする",
      });
      if (!ok) return;
      button.disabled = true;
      if (status) status.textContent = `${from} → ${to} を精算完了にしています...`;
      try {
        // 精算は settlements テーブルへ（費用と同居させない）。
        const fromId = button.dataset.fromId || "";
        const toId = button.dataset.toId || "";
        if (!fromId || !toId) throw new Error("精算相手を特定できませんでした");
        await ExpenseStore.addSettlement(planId(), {
          fromUserId: fromId,
          toUserId: toId,
          amountBaseMinor: amount,
          note: `サイト上で${from}から${to}への精算完了`,
        });
        hooks.renderBase();
        hooks.renderActive();
        const nextStatus = root.querySelector<HTMLElement>("[data-settlement-status]");
        if (nextStatus) {
          nextStatus.textContent = `${from} → ${to} を精算完了にしました。`;
          nextStatus.classList.add("is-ok");
        }
      } catch (error) {
        if (status) {
          status.textContent = (error as Error).message || "精算完了の登録に失敗しました。";
          status.classList.add("is-error");
        }
      } finally {
        button.disabled = false;
      }
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-settlement-delete]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.settlementDelete || "";
      if (!id || !window.confirm("この精算完了記録を取り消しますか？")) return;
      button.disabled = true;
      try {
        await ExpenseStore.removeSettlement(id);
        hooks.renderBase();
        hooks.renderActive();
      } catch (error) {
        window.alert(errorMessage(error) || "精算記録を取り消せませんでした");
        button.disabled = false;
      }
    });
  });
}

export function renderExpenseDetails(settlement: Settlement): void {
  const mount = root.querySelector<HTMLElement>("[data-expense-details]");
  const button = root.querySelector<HTMLButtonElement>("[data-expense-detail-toggle]");
  if (!mount || !button) return;

  // 利用者は identity（user_id）が正。表示名は users から引く。
  const profileName = db.nameOf(currentUserId());
  const canManageExpenses = !isReadOnly();
  const details = settlement.expenseDetails || [];
  const related = canManageExpenses ? details : profileName ? details.filter((detail) => {
    const shares = detail.shares || [];
    const targetNames = detail.targetNames || [];
    return targetNames.includes(profileName) ||
      shares.some((share) => share.name === profileName && Number(share.amount || 0) > 0);
  }) : [];

  // タブになったので常に描画しておく（切り替えは CSS の表示だけ）。
  mount.classList.add("is-visible");
  button.onclick = (): void => {
    applyMoneyTab("details");
  };

  if (!profileName) {
    mount.innerHTML = `<div class="tl-expense-empty">本人設定を登録すると、自分に関連する費用明細を表示できます。</div>`;
    return;
  }

  const shareFor = (detail: ExpenseDetail): string => {
    const share = (detail.shares || []).find((item) => item.name === profileName);
    if (share) return share.amountLabel || formatYen(share.amount);
    if (detail.myShareLabel) return detail.myShareLabel;
    return "-";
  };
  const roleFor = (detail: ExpenseDetail): string => {
    const isPayer = detail.payer === profileName;
    const hasShare = (detail.shares || []).some((item) => item.name === profileName && Number(item.amount || 0) > 0) ||
      (detail.targetNames || []).includes(profileName);
    if (isPayer && hasShare) return "支払・負担";
    if (isPayer) return "立替のみ";
    return "負担";
  };
  const canceled = canManageExpenses
    ? ExpenseStore.canceledList(planId()).map((entry) => ExpenseStore.entryDetail(entry, currentUserId()))
    : [];
  const canceledHtml = canceled.length ? `
    <div class="tl-canceled-expenses">
      <div class="tl-subhead"><span>${icon("xCircle")}</span><b>取り消した費用</b><small>${canceled.length}件</small></div>
      ${canceled.map((detail) => `
        <div class="tl-canceled-expense" data-canceled-expense="${escapeHtml(detail.id || "")}">
          <span>${escapeHtml(mdLabel(detail.date || ""))}</span>
          <b>${escapeHtml(detail.title || "立替")}</b>
          <strong>${escapeHtml(detail.convertedLabel || detail.amountLabel || "")}</strong>
          <button type="button" class="tl-restore-expense" data-expense-restore="${escapeHtml(detail.id || "")}">${icon("arrowPath")}復活</button>
        </div>
      `).join("")}
    </div>` : "";
  // カテゴリごとの色。台帳の左に小さな丸を置いて、一覧の中で種別が拾えるようにする。
  const CAT_TONE: Record<string, string> = {
    食費: "food", 交通: "transport", 宿泊: "lodging",
    観光: "sightseeing", 通信: "communication", 精算: "settle",
  };
  const rowsHtml = related.length ? related.map((detail) => {
    const tone = CAT_TONE[detail.category || ""] || "other";
    const paid = detail.convertedLabel || detail.amountLabel || "";
    return `
    <li class="tl-ledger-row" data-expense-row="${escapeHtml(detail.id || "")}">
      <span class="tl-ledger-dot" data-cat="${tone}" aria-hidden="true"></span>
      <div class="tl-ledger-body">
        <b class="tl-ledger-title">${escapeHtml(detail.title || "立替")}</b>
        <span class="tl-ledger-meta">
          <span class="tl-ledger-cat">${escapeHtml(detail.category || "その他")}</span>
          <i>·</i>${escapeHtml(mdLabel(detail.date || ""))}
          <i>·</i>${escapeHtml(detail.payer || "")}が${escapeHtml(paid)}
        </span>
      </div>
      <div class="tl-ledger-amount">
        <strong>${escapeHtml(shareFor(detail))}</strong>
        <span>${escapeHtml(roleFor(detail))}</span>
      </div>
      ${canManageExpenses ? `<div class="tl-ledger-act">
        <button type="button" class="tl-icon-action" data-expense-edit="${escapeHtml(detail.id || "")}" aria-label="${escapeHtml(detail.title || "費用")}を編集" title="編集">${icon("pencilSquare")}</button>
        <button type="button" class="tl-icon-action danger" data-expense-remove="${escapeHtml(detail.id || "")}" aria-label="${escapeHtml(detail.title || "費用")}を取り消す" title="取り消し">${icon("xCircle")}</button>
      </div>` : ""}
    </li>`;
  }).join("") : `
    <li class="tl-ledger-empty">
      ${canManageExpenses ? "支払い台帳に表示する費用はありません。" : `${escapeHtml(profileName)}に関連する支払いはまだありません。`}
    </li>`;

  mount.innerHTML = `
    ${subhead("documentText", canManageExpenses ? "支払い台帳" : `${escapeHtml(profileName)}に関連する支払い`, `${related.length}件`)}
    <ul class="tl-ledger">
      ${rowsHtml}
    </ul>
    ${canceledHtml}`;
  setupExpenseDetailActions(mount);
}

function setupExpenseDetailActions(mount: HTMLElement): void {
  mount.querySelectorAll<HTMLButtonElement>("[data-expense-edit]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.expenseEdit || "";
      const record = ExpenseStore.get(planId(), id);
      if (!record) return;
      setEditingExpenseId(id);
      renderExpenseEntry(state.data || SAMPLE, { force: true });
      setExpenseSheet(true);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-expense-remove]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.expenseRemove || "";
      const record = ExpenseStore.get(planId(), id);
      if (!record) return;
      const ok = await confirmTransferAction({
        tone: "danger",
        iconName: "xCircle",
        title: "この費用を取り消しますか",
        message: `${record.row.title || "費用"}（${formatYen(record.row.amount_base_minor)}）を支払い台帳から外します。取り消し履歴からあとで復活できます。`,
        confirmLabel: "取り消す",
      });
      if (!ok) return;
      const removed = ExpenseStore.remove(id);
      if (!removed.row) return;
      hooks.renderBase();
      hooks.renderActive();
      showExpenseUndo(removed.row, removed.shares);
    });
  });
  mount.querySelectorAll<HTMLButtonElement>("[data-expense-restore]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.expenseRestore || "";
      if (!id || !ExpenseStore.restoreById(planId(), id)) return;
      hooks.renderBase();
      hooks.renderActive();
      const status = root.querySelector<HTMLElement>("[data-settlement-status]");
      if (status) {
        status.textContent = "取り消した費用を支払い台帳へ戻しました。";
        status.classList.add("is-ok");
      }
    });
  });
}

function showExpenseUndo(record: ExpenseStore.ExpenseRow, shares: ExpenseStore.ExpenseShareRow[]): void {
  const status = root.querySelector<HTMLElement>("[data-settlement-status]");
  if (!status) return;
  status.classList.remove("is-error");
  status.classList.add("is-ok");
  status.innerHTML = `${escapeHtml(record.title || "費用")}を取り消しました。<button type="button" class="tl-inline-undo" data-expense-undo="${escapeHtml(record.id)}">元に戻す</button>`;
  const undo = status.querySelector<HTMLButtonElement>("[data-expense-undo]");
  if (!undo) return;
  undo.addEventListener("click", () => {
    ExpenseStore.restore(record, shares);
    hooks.renderBase();
    hooks.renderActive();
    const nextStatus = root.querySelector<HTMLElement>("[data-settlement-status]");
    if (nextStatus) {
      nextStatus.textContent = `${record.title || "費用"}を元に戻しました。`;
      nextStatus.classList.add("is-ok");
    }
  });
}
