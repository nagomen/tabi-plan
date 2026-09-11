import { icon, type IconName } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { escapeHtml } from "../shared/dom";
import { taskStatus, nextTaskStatus, setTaskStatus, checklistSummary, TASK_STATUS_LABEL } from "../shared/checklist";
import { CONFIG, state } from "./state";
import { root, setHtml, subhead } from "./dom";
import { tasksEditable } from "./plan-access";

// ---- タスク（チェックリスト） -------------------------------------------

/** ローカル計画のチェックリストを localStorage に保存する。 */
function persistChecklist(): void {
  if (!tasksEditable()) return;
  const stored = TripPlans.getData(CONFIG.tripSlug);
  if (!stored) return;
  stored.checklist = state.data.checklist || [];
  TripPlans.saveData(CONFIG.tripSlug, stored);
}

/** チェックリストを3状態（未着手/進行中/完了）のタスクリストとして描画する。 */
export function renderChecklist(): void {
  const items = state.data.checklist || [];
  const editable = tasksEditable();
  const summary = checklistSummary(items);
  // 状態はアイコンだけで示す。「未着手」などの文字を毎行に置くと
  // 幅を食ってタスク名が折り返し、行の高さがばらついていた。
  const STATE_ICON: Record<string, IconName> = { todo: "minus", doing: "clock", done: "check" };

  const rows = items
    .map((item, index) => {
      const status = taskStatus(item);
      const label = TASK_STATUS_LABEL[status];
      const mark = `<span class="tl-task-mark">${icon(STATE_ICON[status] || "minus")}</span>`;
      const state = editable
        ? `<button class="tl-task-state" type="button" data-task-toggle="${index}" aria-label="状態: ${label}（押すと変更）" title="${label}">${mark}</button>`
        : `<span class="tl-task-state" aria-label="状態: ${label}" title="${label}">${mark}</span>`;
      const del = editable
        ? `<button class="tl-task-del" type="button" data-task-del="${index}" aria-label="このタスクを削除">${icon("xMark")}</button>`
        : "";
      return `<li class="tl-task is-${status}">${state}<span class="tl-task-label">${escapeHtml(item.label)}</span>${del}</li>`;
    })
    .join("");

  // 進捗は細い罫線1本で示す（箱やゲージを置かない）。
  const pct = summary.total ? Math.round((summary.done / summary.total) * 100) : 0;
  const progress = summary.total
    ? `<div class="tl-task-progress" role="img" aria-label="完了 ${summary.done} / ${summary.total}">
         <span style="width:${pct}%"></span>
       </div>`
    : "";
  const addHtml = editable
    ? `<form class="tl-task-add" data-task-add>
         <input data-task-input type="text" maxlength="60" placeholder="タスクを追加" aria-label="タスクを追加" autocomplete="off">
         <button type="submit" aria-label="追加">${icon("plus")}</button>
       </form>`
    : "";
  const emptyHtml = !items.length
    ? `<p class="tl-task-empty">${editable ? "タスクを追加すると、ここに並びます。" : "タスクはありません"}</p>`
    : "";

  setHtml(
    "[data-checks]",
    `${subhead("listBullet", "タスク", summary.total ? `${summary.done}/${summary.total}` : "")}
     ${progress}
     <ul class="tl-tasks">${rows}</ul>${emptyHtml}${addHtml}`,
  );
}

/** タスクの状態変更・削除・追加を [data-checks] にデリゲートで束ねる（初期化時に1回）。 */
export function bindChecklist(): void {
  const container = root.querySelector<HTMLElement>("[data-checks]");
  if (!container) return;
  container.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const toggle = target.closest<HTMLElement>("[data-task-toggle]");
    if (toggle) {
      const item = (state.data.checklist || [])[Number(toggle.dataset.taskToggle)];
      if (!item) return;
      setTaskStatus(item, nextTaskStatus(taskStatus(item)));
      persistChecklist();
      renderChecklist();
      return;
    }
    const del = target.closest<HTMLElement>("[data-task-del]");
    if (del) {
      const items = state.data.checklist || [];
      items.splice(Number(del.dataset.taskDel), 1);
      persistChecklist();
      renderChecklist();
    }
  });
  container.addEventListener("submit", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("[data-task-add]")) return;
    event.preventDefault();
    const input = container.querySelector<HTMLInputElement>("[data-task-input]");
    const label = (input?.value || "").trim();
    if (!label) return;
    const items = state.data.checklist || (state.data.checklist = []);
    items.push({ label, done: false, status: "todo" });
    if (input) input.value = "";
    persistChecklist();
    renderChecklist();
  });
}
