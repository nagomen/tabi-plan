// マイページのスライドインドロワー（全画面共通）。
// どの画面からでも「マイページ」導線（[data-mypage] ボタン / mypage.html へのリンク）を押すと、
// 別ページに遷移せず、現在の画面の上に右からスライドインする。
// 中身は mypage.html?embed=1 を iframe で読み込み、既存のマイページ実装を再利用する。

import { icon } from "./icons";
import "./mypage-drawer.css";

let panelEl: HTMLElement | null = null;
let frameEl: HTMLIFrameElement | null = null;
let rootEl: HTMLElement | null = null;
let loaded = false;

/** iframe に読み込むマイページ URL（埋め込みモード） */
const MYPAGE_SRC = "mypage.html?embed=1";

function build(): void {
  if (rootEl) return;
  const root = document.createElement("div");
  root.className = "mp-drawer";
  root.setAttribute("data-mp-drawer", "");
  root.innerHTML =
    `<div class="mp-drawer-scrim" data-mp-close></div>` +
    `<aside class="mp-drawer-panel" role="dialog" aria-modal="true" aria-label="マイページ" tabindex="-1">` +
    `<button class="mp-drawer-close" type="button" data-mp-close aria-label="閉じる">${icon("xMark")}</button>` +
    `<iframe class="mp-drawer-frame" title="マイページ" data-mp-frame></iframe>` +
    `</aside>`;
  document.body.appendChild(root);
  rootEl = root;
  panelEl = root.querySelector(".mp-drawer-panel");
  frameEl = root.querySelector("[data-mp-frame]");
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") closeMypageDrawer();
}

export function openMypageDrawer(): void {
  build();
  if (!rootEl || !frameEl) return;
  // 初回だけ読み込む。以降は再表示（状態を保つ）。
  if (!loaded) {
    frameEl.src = MYPAGE_SRC;
    loaded = true;
  }
  // visibility 切替なので要素は常にレイアウト済み。is-open を付ければそのまま
  // transform/opacity がトランジションする（rAF 不要）。
  rootEl.classList.add("is-open");
  document.documentElement.style.overflow = "hidden";
  document.addEventListener("keydown", onKeydown);
  // フォーカスを iframe 内に移す（読み込み後）
  panelEl?.focus?.();
}

export function closeMypageDrawer(): void {
  if (!rootEl) return;
  rootEl.classList.remove("is-open");
  document.documentElement.style.overflow = "";
  document.removeEventListener("keydown", onKeydown);
}

/**
 * ドロワーを組み込み、マイページ導線をスライドイン起動に差し替える。
 * mountAppHeader から呼ばれ、全画面に一度だけ設置される。
 * 埋め込み中（iframe 内のマイページ自身）では設置しない。
 */
export function initMypageDrawer(): void {
  // 埋め込み中のマイページ自身（?embed=1）にはドロワーを付けない（入れ子防止）
  const params = new URLSearchParams(location.search);
  if (params.has("embed")) return;
  if (document.querySelector("[data-mp-drawer]")) return;

  build();

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    // 閉じる（スクリム / ✕）
    if (target.closest("[data-mp-close]")) {
      event.preventDefault();
      closeMypageDrawer();
      return;
    }
    // マイページを開く（[data-mypage] ボタン、または mypage.html へのリンク）
    const trigger = target.closest<HTMLElement>("[data-mypage], a[href$='mypage.html']");
    if (trigger) {
      event.preventDefault();
      openMypageDrawer();
    }
  });
}
