// 全画面共通アプリヘッダー。マークアップとスタイルの単一の源。
// 各ページは <div data-app-header></div> を1つ置き、main.ts の先頭で
// mountAppHeader(config) を呼ぶ。ページ側は従来どおり data-* フック
// （data-title / data-status / data-mypage など）を querySelector で参照できる。

import { icon, type IconName } from "./icons";
import { escapeHtml } from "./dom";
import { initMypageDrawer } from "./mypage-drawer";
import * as Backend from "./backend";
import * as Friendships from "./friendship-store";
import "./app-header.css";

/** ヘッダー下部の補足行に並べる文言。attr を付けるとページ側が動的更新できる。 */
export interface HeaderMetaSpec {
  /** 例: "data-status"。付けると <span data-status> になり動的更新のフックになる */
  attr?: string;
  /** 初期テキスト */
  text?: string;
}

/** 右側アクション（マイページ・編集・ダッシュボード・本人設定 等）。 */
export interface HeaderActionSpec {
  kind: "link" | "button";
  /** "icon"=円形アイコンのみ / "text"=文言リンク。省略時は text があれば "text" */
  display?: "icon" | "text";
  icon?: IconName;
  /** aria-label / title に使う説明 */
  label: string;
  /** text 表示時の可視テキスト（省略時は label） */
  text?: string;
  /** kind==="link" の遷移先 */
  href?: string;
  /** ページ側フック。例: "data-mypage"（値なしのブール属性として出力） */
  attr?: string;
  /** 初期非表示（ページ側が条件表示する） */
  hidden?: boolean;
}

export interface AppHeaderConfig {
  /** マウント点セレクタ。既定 "[data-app-header]" */
  mount?: string;
  /** 英語キッカー（小見出し） */
  kicker?: string;
  /** タイトル文言 */
  title: string;
  /** タイトルに付けるフック。例: "data-title" / "data-title-echo" */
  titleAttr?: string;
  /** 先頭の戻るリンク */
  back?: { href: string; label: string; attr?: string };
  /** タイトル下の補足行 */
  meta?: HeaderMetaSpec[];
  /** 右側アクション */
  actions?: HeaderActionSpec[];
  /** 指定すると、その画像をヘッダー背景に敷いた「ヒーロー」表示にする（白文字＋スクリム）。 */
  hero?: string;
  /** スマホ幅でヘッダーを上部固定する。固定が必要な一覧系ページだけ有効にする。 */
  mobileFixed?: boolean;
}

/** " data-foo" のようなブール属性トークン（無指定なら空文字）。 */
function attrToken(attr?: string): string {
  return attr ? ` ${attr}` : "";
}

function renderAction(action: HeaderActionSpec): string {
  const display = action.display ?? (action.text ? "text" : "icon");
  const cls = `ah-act ah-act--${display}`;
  const hidden = action.hidden ? " hidden" : "";
  const aria = ` aria-label="${escapeHtml(action.label)}" title="${escapeHtml(action.label)}"`;
  const iconHtml = action.icon ? icon(action.icon) : "";
  const isMypageAction =
    action.icon === "user" ||
    Boolean(action.attr && /\bdata-mypage\b/.test(action.attr)) ||
    Boolean(action.href && /(?:^|\/)mypage\.html(?:[?#]|$)/.test(action.href));
  const badge = isMypageAction ? '<span class="ah-notify" data-header-friend-badge hidden></span>' : "";
  const inner =
    display === "icon"
      ? iconHtml + badge
      : `${iconHtml}<span>${escapeHtml(action.text ?? action.label)}</span>${badge}`;
  if (action.kind === "link") {
    const href = escapeHtml(action.href ?? "#");
    return `<a class="${cls}"${attrToken(action.attr)} href="${href}"${aria}${hidden}>${inner}</a>`;
  }
  return `<button class="${cls}" type="button"${attrToken(action.attr)}${aria}${hidden}>${inner}</button>`;
}

function updateFriendBadges(root: ParentNode = document): void {
  const badges = Array.from(root.querySelectorAll<HTMLElement>("[data-header-friend-badge]"));
  if (!badges.length) return;
  const count = Friendships.incomingRequests().length;
  badges.forEach((badge) => {
    badge.hidden = count === 0;
    badge.textContent = count ? String(count) : "";
    const action = badge.closest<HTMLElement>(".ah-act");
    if (action) {
      action.classList.toggle("has-notify", count > 0);
      const base = action.getAttribute("aria-label") || action.getAttribute("title") || "マイページ";
      action.setAttribute("aria-label", count ? `${base.replace(/（未処理.*?）$/, "")}（未処理の友達申請 ${count}件）` : base.replace(/（未処理.*?）$/, ""));
    }
  });
}

function cssUrl(value: string): string {
  const resolved = /^(?:data:|blob:|https?:|\/)/i.test(value) ? value : new URL(value, document.baseURI).href;
  return `url(${JSON.stringify(resolved)})`;
}

export function setAppHeaderHero(el: HTMLElement, hero: string): void {
  el.classList.add("ah--hero");
  el.style.setProperty("--ah-hero-image", cssUrl(hero));
}

/** ヘッダーの HTML 文字列を組み立てる（テスト・SSR 用に純粋関数として公開）。 */
export function renderAppHeaderHtml(config: AppHeaderConfig): string {
  const back = config.back
    ? `<a class="ah-back"${attrToken(config.back.attr)} href="${escapeHtml(config.back.href)}" ` +
      `aria-label="${escapeHtml(config.back.label)}" title="${escapeHtml(config.back.label)}">` +
      `${icon("chevronLeft")}</a>`
    : "";
  const kicker = config.kicker ? `<p class="ah-kicker">${escapeHtml(config.kicker)}</p>` : "";
  const title = `<h1 class="ah-title"${attrToken(config.titleAttr)}>${escapeHtml(config.title)}</h1>`;
  const meta =
    config.meta && config.meta.length
      ? `<div class="ah-meta">${config.meta
          .map((m) => `<span${attrToken(m.attr)}>${escapeHtml(m.text ?? "")}</span>`)
          .join("")}</div>`
      : "";
  const actions =
    config.actions && config.actions.length
      ? `<div class="ah-actions">${config.actions.map(renderAction).join("")}</div>`
      : "";
  const heroCls = config.hero ? " ah--hero" : "";
  const fixedCls = config.mobileFixed ? " ah--mobile-fixed" : "";
  return `<header class="ah${heroCls}${fixedCls}">${back}<div class="ah-main">${kicker}${title}${meta}</div>${actions}</header>`;
}

/**
 * マウント点（既定 [data-app-header]）を共通ヘッダーに置き換える。
 * 返り値の <header> は必要ならページ側がさらに参照できる。
 */
export function mountAppHeader(config: AppHeaderConfig): HTMLElement {
  const selector = config.mount ?? "[data-app-header]";
  const mount = document.querySelector(selector);
  if (!mount) throw new Error(`app-header のマウント点が見つかりません: ${selector}`);
  const template = document.createElement("template");
  template.innerHTML = renderAppHeaderHtml(config).trim();
  const el = template.content.firstElementChild as HTMLElement;
  if (config.hero) {
    setAppHeaderHero(el, config.hero);
  }
  mount.replaceWith(el);
  // マイページのスライドインドロワーを全画面共通で設置（埋め込み時はスキップ）
  initMypageDrawer();
  updateFriendBadges(el);
  void Backend.preload().then(() => updateFriendBadges(el));
  window.addEventListener("trip-friendships-change", () => updateFriendBadges(el));
  window.addEventListener("trip-backend-sync", () => updateFriendBadges(el));
  window.addEventListener("trip-account-logout", () => updateFriendBadges(el));
  return el;
}
