// マイページ。ユーザー名の編集、作成/所属計画の一覧、全計画の日程カレンダー。
// データは localStorage(JSON): 計画は plans-store、ユーザーは user-store。

import "../shared/ui.css";
import { initPageTransitions } from "../shared/page-transition";
import { icon, type IconName } from "../shared/icons";
import { escapeHtml, makeScopedQuery } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { getUser, setUserName } from "../shared/user-store";
import { isMemberOf } from "../shared/membership";
import { friendCandidates } from "../shared/friend-store";
import { getPayLink, setPayLink } from "../shared/payment-links";
import { currentAccount, logOut, updateName, isLoggedIn } from "../shared/account-store";
import { isHistoryPublic, setHistoryPublic } from "../shared/history-privacy";
import { mountAppHeader } from "../shared/app-header";

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
  ["[data-ic-pay]", "banknotes"],
  ["[data-ic-prev]", "chevronLeft"],
  ["[data-ic-next]", "chevronRight"],
];
ICONS.forEach(([sel, name]) => {
  const el = document.querySelector(sel);
  if (el) el.insertAdjacentHTML("afterbegin", icon(name) + (el.tagName === "BUTTON" && el.textContent ? " " : ""));
});

// ---- 配色（計画ごとに一意の色） ----------------------------------------

const PALETTE = ["#0b5a42", "#22719d", "#b87418", "#6246a6", "#cf4f3d", "#2f7d6b", "#8a5a2b", "#3b4c8a"];
function colorFor(slug: string, allSlugs: string[]): string {
  const i = allSlugs.indexOf(slug);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

// ---- 日付ユーティリティ -------------------------------------------------

function toDate(value: string | undefined): Date | null {
  const m = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(String(value || ""));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function fmtMD(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface PlanRange { start: Date; end: Date }

/** 計画の期間を {start,end} で返す。行程の日付があれば最小〜最大、無ければ meta.dates を解析。 */
function planRange(plan: PlanMeta): PlanRange | null {
  const data = TripPlans.getData(plan.slug);
  const dates = (data?.itinerary || [])
    .map((it) => toDate(it.date))
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
  const parts = String(plan.dates || "")
    .split(/[-–—〜~]/)
    .map((s) => toDate(s.trim()))
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
  historyToggle.disabled = !name;
  historyToggle.checked = name ? isHistoryPublic(name) : false;
  historyNote.textContent = name
    ? "他の人があなたのアイコンから、行った場所やカレンダーを見られます"
    : "名前を設定すると、旅行履歴の公開/非公開を選べます";
}
historyToggle.addEventListener("change", () => {
  const name = getUser().name.trim();
  if (!name) return;
  setHistoryPublic(name, historyToggle.checked);
});

function renderAccount(): void {
  const account = currentAccount();
  if (account) {
    accountEl.innerHTML =
      `${icon("user")}<span>${escapeHtml(account.email)} でログイン中</span>` +
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
      location.replace(new URL("plans.html", location.href).href);
    });
  } else {
    accountEl.innerHTML = `<a href="login.html">ログイン / 新規登録</a><span>すると別端末でも同じ名前で使えます（試作）</span>`;
  }
}

// 名前は自動保存（入力中はデバウンス、確定時は即時）。
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
    : `index.html?plan=${encodeURIComponent(plan.slug)}`;
  const dotColor = draft ? "#b87418" : colorFor(plan.slug, allSlugs);
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
function showTab(name: string): void {
  tabs.forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  views.forEach((v) => { v.hidden = v.dataset.view !== name; });
  if (name === "schedule") renderCalendar();
  if (name === "pay") renderPayLinks();
}
tabs.forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab || "plans")));

// ---- カレンダー（全計画の日程） ----------------------------------------

const calMount = qs<HTMLElement>("[data-cal]");
const calTitle = qs<HTMLElement>("[data-cal-title]");
const calLegend = qs<HTMLElement>("[data-cal-legend]");
const DOW = ["日", "月", "火", "水", "木", "金", "土"];

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
      return range ? { plan, range, color: colorFor(plan.slug, allSlugs) } : null;
    })
    .filter((b): b is PlanBand => Boolean(b));

  calTitle.textContent = `${view.year}年${view.month + 1}月`;

  const first = new Date(view.year, view.month, 1);
  const gridStart = new Date(view.year, view.month, 1 - first.getDay());

  const covers = (band: PlanBand, d: Date): boolean => {
    const t = d.getTime();
    const s = new Date(band.range.start.getFullYear(), band.range.start.getMonth(), band.range.start.getDate()).getTime();
    const e = new Date(band.range.end.getFullYear(), band.range.end.getMonth(), band.range.end.getDate()).getTime();
    return t >= s && t <= e;
  };

  let html = DOW.map((d, i) => `<div class="mp-cal-dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${d}</div>`).join("");

  for (let i = 0; i < 42; i += 1) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const out = d.getMonth() !== view.month;
    const isToday = sameDay(d, today);
    const dayBands = bands.filter((b) => covers(b, d));
    const shown = dayBands.slice(0, 3);
    const prevD = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1);
    const nextD = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

    const bars = shown
      .map((b) => {
        const contL = covers(b, prevD) && d.getDay() !== 0;
        const contR = covers(b, nextD) && d.getDay() !== 6;
        const label = !contL ? escapeHtml(b.plan.title || "旅行") : "";
        const cls = `mp-bar${contL ? " cont-l" : ""}${contR ? " cont-r" : ""}`;
        return `<a class="${cls}" href="index.html?plan=${encodeURIComponent(b.plan.slug)}" style="background:${b.color}" title="${escapeHtml(b.plan.title || "")}">${label}</a>`;
      })
      .join("");
    const more = dayBands.length > shown.length ? `<span class="mp-bar-more">+${dayBands.length - shown.length}</span>` : "";

    html +=
      `<div class="mp-cell${out ? " is-out" : ""}${isToday ? " is-today" : ""}">` +
      `<span class="mp-cell-n">${d.getDate()}</span>` +
      `<span class="mp-cell-bars">${bars}${more}</span>` +
      `</div>`;
  }
  calMount.innerHTML = html;

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
            `<span class="mp-legend-dates">${fmtMD(b.range.start)}〜${fmtMD(b.range.end)}</span>` +
            `</a>`,
        )
        .join("")
    : `<div class="mp-empty"><b>この月の旅行はありません</b><span>前後の月も確認してください</span></div>`;
}

qs<HTMLButtonElement>("[data-cal-prev]").addEventListener("click", () => {
  view.month -= 1;
  if (view.month < 0) { view.month = 11; view.year -= 1; }
  renderCalendar();
});
qs<HTMLButtonElement>("[data-cal-next]").addEventListener("click", () => {
  view.month += 1;
  if (view.month > 11) { view.month = 0; view.year += 1; }
  renderCalendar();
});

// ---- 送金リンク登録（PayPay 受取リンク/ID） ----------------------------

const payMount = qs<HTMLElement>("[data-paylinks]");
const payCount = qs<HTMLElement>("[data-pay-count]");

/** 自分の名前＋全計画のメンバーを重複なく集めて、登録対象の名前一覧にする。 */
function payNames(): string[] {
  const me = getUser().name.trim();
  const all = friendCandidates(me ? [me] : []);
  const names = me ? [me, ...all] : all;
  return Array.from(new Set(names.filter(Boolean)));
}

function renderPayLinks(): void {
  const me = getUser().name.trim();
  const names = payNames();
  payCount.textContent = names.length ? `${names.length}人` : "";
  if (!names.length) {
    payMount.innerHTML = `<div class="mp-empty"><b>メンバーがいません</b><span>計画にメンバーを追加すると、ここで送金リンクを登録できます</span></div>`;
    return;
  }
  payMount.innerHTML = names
    .map((name) => {
      const link = getPayLink(name);
      const self = Boolean(me) && name === me;
      return (
        `<div class="mp-pay-row">` +
        `<span class="mp-pay-name">${self ? icon("user") : ""}${escapeHtml(name)}${self ? `<span class="mp-badge">自分</span>` : ""}</span>` +
        `<input type="text" inputmode="url" data-pay-name="${escapeHtml(name)}" value="${escapeHtml(link?.paypay || "")}" placeholder="https://qr.paypay.ne.jp/… または ID" aria-label="${escapeHtml(name)}の送金リンク">` +
        `</div>`
      );
    })
    .join("");
}

let payTimer = 0;
payMount.addEventListener("input", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const name = input.dataset.payName || "";
  if (!name) return;
  window.clearTimeout(payTimer);
  const value = input.value;
  payTimer = window.setTimeout(() => setPayLink(name, value), 400);
});

// ---- 起動 ---------------------------------------------------------------

async function init(): Promise<void> {
  await Backend.preload();
  void dayKey; // 予約（将来の選択状態用）
  registerServiceWorker();
  renderProfile();
  renderPlans();
  renderCalendar(); // PC は左右2カラムで日程も常時表示するため初期描画する
  renderPayLinks(); // PC ではタブが無く常時表示されるため初期描画する
}

void init();
