import { state } from "./editor-state";
import { root, statusEl, savebarNoteEl } from "./editor-dom";

export function lockEditor(message: string): false {
  state.editorLocked = true;
  statusEl.textContent = message;
  statusEl.className = "is-dirty";
  savebarNoteEl.textContent = message;
  return false;
}

export function applyEditorLock(): void {
  root.classList.add("is-readonly");
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    "input, select, textarea, button",
  ).forEach((control) => {
    control.disabled = true;
  });
}

/** 公開共同編集者には、サーバーが許可する行程・都市だけを編集させる。 */
export function applyMetadataLock(): void {
  root.classList.add("is-metadata-readonly");
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    '[data-f="title"], [data-range-trigger], [data-f="note"], [data-member-field] input, ' +
    '[data-member-field] select, [data-member-field] button, [data-cover-input], [data-cover-clear]',
  ).forEach((control) => { control.disabled = true; });
  savebarNoteEl.textContent = "公開共同編集では、行程と訪問地だけを編集できます。旅行名・期間・画像は正式メンバーが変更できます。";
}
