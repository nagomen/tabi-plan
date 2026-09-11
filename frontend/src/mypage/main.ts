// マイページ。ユーザー名の編集、作成/所属計画の一覧、全計画の日程カレンダー。
// データは localStorage(JSON): 計画は plans-store、ユーザーは user-store。

import "../shared/ui.css";
import * as db from "../shared/db";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import { icon, type IconName } from "../shared/icons";
import { makeScopedQuery } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import { mountAppHeader } from "../shared/app-header";
import { mountCalendar } from "./calendar-view";
import { mountFriends } from "./friends";
import { mountLoginMethods } from "./login-methods";
import { mountPayLinks } from "./pay-links";
import { mountPlansList } from "./plans-list";
import { mountProfile } from "./profile";

initPageTransitions();

// ドロワー（右スライドイン）に埋め込まれている時は embed=1 で開かれる。
// その場合は「戻る」を出さず（ドロワーの✕で閉じる）、計画リンクは最上位ウィンドウで開く。
const isEmbedded = new URLSearchParams(location.search).has("embed");
if (isEmbedded) {
  document.documentElement.classList.add("is-embedded");
  const base = document.createElement("base");
  base.target = "_top";
  document.head.prepend(base);
}

mountAppHeader({
  kicker: "My Page",
  title: "マイページ",
  back: isEmbedded ? undefined : { href: "plans.html", label: "計画一覧へ戻る" },
});

const { qs } = makeScopedQuery(document);

// ---- アイコン注入 -------------------------------------------------------

const ICONS: [string, IconName][] = [
  ["[data-ic-back]", "chevronLeft"],
  ["[data-ic-plans]", "listBullet"],
  ["[data-ic-schedule]", "calendarDays"],
  ["[data-ic-settings]", "cog"],
  ["[data-ic-friends]", "users"],
  ["[data-ic-prev]", "chevronLeft"],
  ["[data-ic-next]", "chevronRight"],
];
ICONS.forEach(([sel, name]) => {
  const el = document.querySelector(sel);
  if (el) el.insertAdjacentHTML("afterbegin", icon(name) + (el.tagName === "BUTTON" && el.textContent ? " " : ""));
});

// ---- 計画リスト ---------------------------------------------------------

const { renderPlans } = mountPlansList({
  planMount: qs<HTMLElement>("[data-plans]"),
  planCount: qs<HTMLElement>("[data-plan-count]"),
});

// ---- プロフィール -------------------------------------------------------

const { renderProfile } = mountProfile(
  {
    nameInput: qs<HTMLInputElement>("[data-name]"),
    avatarEl: qs<HTMLElement>("[data-avatar]"),
    noteEl: qs<HTMLElement>("[data-profile-note]"),
    accountEl: qs<HTMLElement>("[data-account]"),
    historyToggle: qs<HTMLInputElement>("[data-history-public]"),
    historyNote: qs<HTMLElement>("[data-history-note]"),
  },
  { isEmbedded, renderPlans },
);

// ---- タブ ---------------------------------------------------------------

const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".mp-tab"));
const views = Array.from(document.querySelectorAll<HTMLElement>(".mp-view"));
const initialTab = new URLSearchParams(location.search).get("tab") || "";
/** PC で常時表示になる部分（スマホではタブを開いたときに描く）。 */
const wideLayout = window.matchMedia("(min-width: 860px)");
let hiddenViewsDrawn = false;

function renderHiddenViews(): void {
  hiddenViewsDrawn = true;
  renderCalendar();
  renderPayLinks();
  renderLoginMethods();
  renderFriends();
}

// 横幅が広がって全部並ぶようになったら、そのとき描く
wideLayout.addEventListener("change", (event) => {
  if (event.matches && !hiddenViewsDrawn) renderHiddenViews();
});

function showTab(name: string): void {
  tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  views.forEach((v) => { v.hidden = v.dataset.view !== name; });
  if (name === "schedule") renderCalendar();
  if (name === "pay") { renderPayLinks(); renderLoginMethods(); }
  if (name === "friends") renderFriends();
}
tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab || "plans")));

// ---- カレンダー（全計画の日程） ----------------------------------------

const { renderCalendar } = mountCalendar({
  calMount: qs<HTMLElement>("[data-cal]"),
  calTitle: qs<HTMLElement>("[data-cal-title]"),
  calLegend: qs<HTMLElement>("[data-cal-legend]"),
  calPrev: qs<HTMLButtonElement>("[data-cal-prev]"),
  calNext: qs<HTMLButtonElement>("[data-cal-next]"),
});

// ---- 送金リンク登録（PayPay 受取リンク/ID） ----------------------------

const { renderPayLinks } = mountPayLinks({
  payMount: qs<HTMLElement>("[data-paylinks]"),
  payCount: qs<HTMLElement>("[data-pay-count]"),
});

// ---- ログイン方法（メール / LINE） --------------------------------------

const { renderLoginMethods } = mountLoginMethods({
  loginMethodsEl: document.querySelector<HTMLElement>("[data-login-methods]"),
  loginNoteEl: document.querySelector<HTMLElement>("[data-login-note]"),
});

// ---- 友達（アカウント単位） ----------------------------------------------

const { renderFriends } = mountFriends({
  friendNoteEl: qs<HTMLElement>("[data-friend-note]"),
  friendSearchForm: qs<HTMLFormElement>("[data-friend-search-form]"),
  friendSearchInput: qs<HTMLInputElement>("[data-friend-search-input]"),
  friendSearchResults: qs<HTMLElement>("[data-friend-search-results]"),
  friendIncomingMount: qs<HTMLElement>("[data-friend-incoming]"),
  friendIncomingCount: qs<HTMLElement>("[data-friend-incoming-count]"),
  friendListMount: qs<HTMLElement>("[data-friend-list]"),
  friendCount: qs<HTMLElement>("[data-friend-count]"),
  friendOutgoingMount: qs<HTMLElement>("[data-friend-outgoing]"),
  friendOutgoingCount: qs<HTMLElement>("[data-friend-outgoing-count]"),
  friendTabBadge: qs<HTMLElement>("[data-friend-tab-badge]"),
});

// ---- 起動 ---------------------------------------------------------------

async function init(): Promise<void> {
  await Backend.preload();
  registerServiceWorker();
  renderProfile();
  renderPlans();
  // PC はタブが無く全部並ぶので最初から描く。スマホはタブなので、
  // 開いたときに showTab が描く。最初から全部描くと、見えていない
  // カレンダー・支払い・友達のぶんまで初回の処理時間に乗ってしまう。
  if (wideLayout.matches) renderHiddenViews();
  if (initialTab && tabs.some((tab) => tab.dataset.tab === initialTab)) showTab(initialTab);
}

void db.load().then(init);

// 控え（キャッシュ）で先に描いているので、裏の取り直しで中身が変わったら描き直す。
db.onDbSync(() => {
  renderProfile();
  renderPlans();
  renderCalendar();
  renderPayLinks();
  renderFriends();
});
