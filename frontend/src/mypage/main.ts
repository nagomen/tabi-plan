// マイページ。ユーザー名の編集、作成/所属計画の一覧、全計画の日程カレンダー。
// データは localStorage(JSON): 計画は plans-store、ユーザーは user-store。

import "../shared/ui.css";
import * as db from "../shared/db";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import { icon, type IconName } from "../shared/icons";
import { escapeHtml, makeScopedQuery } from "../shared/dom";
import { mdOf, parseFlexibleDate } from "../shared/date";
import { planDashboardHref } from "../shared/plan-url";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { getUser, setUserName } from "../shared/user-store";
import { currentUserId } from "../shared/identity";
import { isMemberOf } from "../shared/membership";
import { currentAccount, logOut, updateName, isLoggedIn } from "../shared/account-store";
import { isHistoryPublic, setHistoryPublic } from "../shared/history-privacy";
import { mountAppHeader } from "../shared/app-header";
import { monthCalendarHtml, bandColor, stepMonth } from "../shared/calendar";
import { mountFriends } from "./friends";
import { mountLoginMethods } from "./login-methods";
import { mountPayLinks } from "./pay-links";

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

// ---- 日付ユーティリティ -------------------------------------------------

interface PlanRange { start: Date; end: Date }

/** 計画の期間を {start,end} で返す。行程の日付があれば最小〜最大、無ければ meta.dates を解析。 */
function planRange(plan: PlanMeta): PlanRange | null {
  const data = TripPlans.getData(plan.slug);
  const dates = (data?.itinerary || [])
    .map((it) => parseFlexibleDate(it.date))
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
  const parts = String(plan.dates || "")
    .split(/[-–—〜~]/)
    .map((s) => parseFlexibleDate(s.trim()))
    .filter((d): d is Date => Boolean(d));
  if (parts.length) return { start: parts[0], end: parts[parts.length - 1] };
  return null;
}

// ---- プロフィール -------------------------------------------------------

const nameInput = qs<HTMLInputElement>("[data-name]");
const avatarEl = qs<HTMLElement>("[data-avatar]");
const noteEl = qs<HTMLElement>("[data-profile-note]");
const accountEl = qs<HTMLElement>("[data-account]");

function avatarText(name: string): string {
  return (name.trim().slice(0, 1) || "?").toUpperCase();
}

function renderProfile(): void {
  const user = getUser();
  // LINE で登録した場合、この端末には名前が無い。サーバー側の表示名を引き継ぐ
  // （以降はここで変えた名前が正。LINE 名で上書きはしない）。
  if (!user.name.trim()) {
    const serverName = db.nameOf(currentUserId());
    if (serverName) {
      setUserName(serverName);
      user.name = serverName;
    }
  }
  nameInput.value = user.name;
  avatarEl.textContent = avatarText(user.name);
  renderAccount();
  renderHistorySetting();
}

// 旅行履歴の公開設定（名前キーで保存）。名前未設定なら無効化。
const historyToggle = qs<HTMLInputElement>("[data-history-public]");
const historyNote = qs<HTMLElement>("[data-history-note]");
function renderHistorySetting(): void {
  const name = getUser().name.trim();
  const userId = currentUserId();
  historyToggle.disabled = !name;
  historyToggle.checked = name && userId ? isHistoryPublic(userId) : false;
  historyNote.textContent = name
    ? "あなたのアイコンから開くプロフィールに、行った場所やカレンダーを掲載します（共有計画内の参加者表示は変わりません）"
    : "名前を設定すると、旅行履歴プロフィールへの掲載を選べます";
}
historyToggle.addEventListener("change", () => {
  const name = getUser().name.trim();
  const userId = currentUserId();
  if (!name || !userId) return;
  setHistoryPublic(userId, historyToggle.checked);
});

function renderAccount(): void {
  const account = currentAccount();
  if (account) {
    // LINE で登録した場合はメールを持たない。その場合は表示名で伝える。
    const who = account.email || account.name || "この端末";
    accountEl.innerHTML =
      `${icon("user")}<span>${escapeHtml(who)} でログイン中</span>` +
      `<a href="plans.html" class="danger" data-logout data-no-transition="true">ログアウト</a>`;
    const logout = accountEl.querySelector<HTMLAnchorElement>("[data-logout]");
    logout?.addEventListener("click", (e) => {
      e.preventDefault();
      if (isEmbedded) {
        try {
          window.parent?.postMessage({ type: "trip-account-logout" }, location.origin);
        } catch {
          /* ignore */
        }
        return;
      }
      logOut();
      navigateWithPageTransition("plans.html", { replace: true });
    });
  } else {
    accountEl.innerHTML = `<a href="login.html">ログイン / 新規登録</a><span>すると別端末でも同じ旅行計画を使えます</span>`;
  }
}

// 名前は自動保存（入力中はデバウンス、確定時は即時）。
// 表示名は users テーブルの1列なので、変更はそこを更新するだけで済む。
// 以前は名前が実質的な主キーだったため、計画のメンバー欄・費用の支払者・
// 候補の票・送金リンクへ配り直す必要があった（shared/rename.ts）。
let nameTimer = 0;
let noteTimer = 0;

function commitName(): void {
  const user = setUserName(nameInput.value);
  if (isLoggedIn()) updateName(user.name); // ログイン中はアカウントの表示名も更新
  avatarEl.textContent = avatarText(user.name);
  renderPlans();
  renderHistorySetting();
  noteEl.textContent = user.name ? "保存しました" : "入力すると自動で保存されます";
  window.clearTimeout(noteTimer);
  if (user.name) noteTimer = window.setTimeout(() => { noteEl.textContent = ""; }, 2000);
}
nameInput.addEventListener("input", () => {
  window.clearTimeout(nameTimer);
  nameTimer = window.setTimeout(commitName, 500);
});
nameInput.addEventListener("blur", () => { window.clearTimeout(nameTimer); commitName(); });
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { window.clearTimeout(nameTimer); commitName(); nameInput.blur(); }
});

// ---- 計画リスト ---------------------------------------------------------

const planMount = qs<HTMLElement>("[data-plans]");
const planCount = qs<HTMLElement>("[data-plan-count]");

function planRow(plan: PlanMeta, allSlugs: string[]): string {
  const meta = [plan.dates, plan.members].filter(Boolean).map(escapeHtml).join(" ・ ");
  const draft = !TripPlans.isPublished(plan);
  const href = draft
    ? `plan-editor.html?plan=${encodeURIComponent(plan.slug)}`
    : planDashboardHref(plan.slug);
  const dotColor = draft ? "#b87418" : bandColor(plan.slug, allSlugs);
  return (
    `<a class="mp-row${draft ? " is-draft" : ""}" href="${href}">` +
    `<span class="mp-dot" style="background:${dotColor}"></span>` +
    `<span class="mp-row-body">` +
    `<span class="mp-row-name">` +
    `<span>${escapeHtml(plan.title || "無題の旅行")}</span>` +
    (draft ? `<span class="mp-draft-badge">${icon("pencilSquare")}作成中</span>` : "") +
    `</span>` +
    (meta ? `<span class="mp-row-meta">${meta}</span>` : "") +
    (draft ? `<span class="mp-row-meta mp-row-meta-draft">保存すると公開計画として扱われます</span>` : "") +
    `</span>` +
    `<span class="mp-chev">${icon("chevronRight")}</span>` +
    `</a>`
  );
}

// マイページは「自分が参加している計画のみ」を表示する。
function renderPlans(): void {
  const all = TripPlans.list();
  const allSlugs = all.map((p) => p.slug); // 色は全計画基準で安定させる
  const userName = getUser().name;
  const list = all.filter(isMemberOf);
  const draftCount = list.filter((p) => !TripPlans.isPublished(p)).length;
  planCount.textContent = list.length ? `${list.length}件${draftCount ? `・作成中${draftCount}件` : ""}` : "";

  if (list.length) {
    planMount.innerHTML = list.map((p) => planRow(p, allSlugs)).join("");
    return;
  }
  planMount.innerHTML = userName
    ? `<div class="mp-empty"><b>参加している計画はありません</b><span>計画のメンバーに「${escapeHtml(userName)}」を追加すると表示されます</span></div>`
    : `<div class="mp-empty"><b>名前を設定してください</b><span>上で名前を入力（またはログイン）すると、参加している計画が表示されます</span></div>`;
}

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

const calMount = qs<HTMLElement>("[data-cal]");
const calTitle = qs<HTMLElement>("[data-cal-title]");
const calLegend = qs<HTMLElement>("[data-cal-legend]");
const today = new Date();
const view = { year: today.getFullYear(), month: today.getMonth() };

interface PlanBand { plan: PlanMeta; range: PlanRange; color: string }

function renderCalendar(): void {
  const all = TripPlans.list();
  const allSlugs = all.map((p) => p.slug);
  // カレンダーも「自分が参加している計画のみ」。
  const mine = all.filter(isMemberOf);
  const bands: PlanBand[] = mine
    .map((plan) => {
      const range = planRange(plan);
      return range ? { plan, range, color: bandColor(plan.slug, allSlugs) } : null;
    })
    .filter((b): b is PlanBand => Boolean(b));

  calTitle.textContent = `${view.year}年${view.month + 1}月`;

  calMount.innerHTML = monthCalendarHtml({
    year: view.year,
    month: view.month,
    today,
    classPrefix: "mp",
    bands: bands.map((band) => ({
      slug: band.plan.slug,
      title: band.plan.title || "旅行",
      start: band.range.start,
      end: band.range.end,
      color: band.color,
    })),
  });

  // 凡例: 表示中の月に重なる計画
  const monthStart = new Date(view.year, view.month, 1).getTime();
  const monthEnd = new Date(view.year, view.month + 1, 0).getTime();
  const inMonth = bands.filter((b) => {
    const s = new Date(b.range.start.getFullYear(), b.range.start.getMonth(), b.range.start.getDate()).getTime();
    const e = new Date(b.range.end.getFullYear(), b.range.end.getMonth(), b.range.end.getDate()).getTime();
    return e >= monthStart && s <= monthEnd;
  });
  calLegend.innerHTML = inMonth.length
    ? inMonth
        .map(
          (b) =>
            `<a class="mp-legend-row" href="index.html?plan=${encodeURIComponent(b.plan.slug)}">` +
            `<span class="mp-legend-sw" style="background:${b.color}"></span>` +
            `<span class="mp-legend-name">${escapeHtml(b.plan.title || "無題の旅行")}</span>` +
            `<span class="mp-legend-dates">${mdOf(b.range.start)}〜${mdOf(b.range.end)}</span>` +
            `</a>`,
        )
        .join("")
    : `<div class="mp-empty"><b>この月の旅行はありません</b><span>前後の月も確認してください</span></div>`;
}

qs<HTMLButtonElement>("[data-cal-prev]").addEventListener("click", () => { stepMonth(view, -1); renderCalendar(); });
qs<HTMLButtonElement>("[data-cal-next]").addEventListener("click", () => { stepMonth(view, 1); renderCalendar(); });

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
