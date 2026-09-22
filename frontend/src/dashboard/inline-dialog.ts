// 編集モードのダイアログの土台。観覧画面から離れずに開くので、
// 画面遷移はせず <dialog> をその場に作って使い回す。

import { root } from "./dom";

/**
 * marker 属性を持つダイアログを（無ければ作って）返す。
 * [data-dialog-close] を持つ要素は自動で閉じるボタンになる。
 */
export function dialogNode(marker: string, innerHtml: string, wire?: (node: HTMLDialogElement) => void): HTMLDialogElement {
  const existing = root.querySelector<HTMLDialogElement>(`[${marker}]`);
  if (existing) return existing;
  root.insertAdjacentHTML("beforeend", `<dialog class="tl-inline-dialog" ${marker}>${innerHtml}</dialog>`);
  const node = root.querySelector<HTMLDialogElement>(`[${marker}]`)!;
  node.querySelectorAll<HTMLElement>("[data-dialog-close]").forEach((button) =>
    button.addEventListener("click", () => node.close()));
  wire?.(node);
  return node;
}

export function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(node: ParentNode, name: string): T {
  return node.querySelector<T>(`[name="${name}"]`)!;
}

/** ダイアログの見出し（タイトルと閉じるボタン）。 */
export function dialogHead(title: string, marker = ""): string {
  return `<div class="tl-inline-dialog-head"><strong ${marker}>${title}</strong>` +
    `<button type="button" data-dialog-close aria-label="閉じる">×</button></div>`;
}
