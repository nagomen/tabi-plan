import { root, setLoading } from "./dom";

export function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || "");
  const box = document.createElement("div");
  box.className = "tl-error";
  box.textContent = `データ読み込みに失敗しました。サンプル表示に戻します: ${message}`;
  root.insertAdjacentElement("afterbegin", box);
}

export function renderAccessDenied(): void {
  setLoading(false);
  root.classList.add("is-readonly");
  root
    .querySelectorAll<HTMLElement>(".tl-actions, .tl-days, .tl-main, .tl-mobile-nav")
    .forEach((el) => {
      el.hidden = true;
    });
  const box = document.createElement("div");
  box.className = "tl-error";
  box.textContent = "この旅行計画は限定公開です。招待リンクから参加するか、権限のあるアカウントでログインしてください。";
  const header = root.querySelector(".ah");
  if (header) header.insertAdjacentElement("afterend", box);
  else root.insertAdjacentElement("afterbegin", box);
}
