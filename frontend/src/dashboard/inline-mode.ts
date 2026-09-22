// 観覧画面の「編集モード」の状態。観覧と編集で画面を分けないので、
// 表示側（行程カード・地図）はこのフラグだけを見て編集用の操作を足す。

import { hooks } from "./state";
import { root } from "./dom";

let editing = false;

export function isInlineEditing(): boolean {
  return editing;
}

export function setInlineEditing(value: boolean): void {
  if (editing === value) return;
  editing = value;
  root.classList.toggle("is-inline-editing", value);
  const bar = root.querySelector<HTMLElement>("[data-inline-editbar]");
  if (bar) bar.hidden = !value;
  const status = root.querySelector<HTMLElement>("[data-inline-bar-status]");
  if (status) status.textContent = "";
  const head = root.querySelector<HTMLElement>("[data-edit-head]");
  if (head) {
    head.setAttribute("aria-label", value ? "編集を完了" : "計画を編集");
    head.setAttribute("title", value ? "編集を完了" : "計画を編集");
  }
  hooks.renderActive();
}

/** 編集バーの一行メッセージ（保存の結果を出す）。 */
export function showEditBarStatus(text: string): void {
  const status = root.querySelector<HTMLElement>("[data-inline-bar-status]");
  if (status) status.textContent = text;
}

export function editBarStatusEl(): HTMLElement | null {
  return root.querySelector<HTMLElement>("[data-inline-bar-status]");
}
