// マイページ。ユーザー名の編集、作成/所属計画の一覧、全計画の日程カレンダー。
// データは localStorage(JSON): 計画は plans-store、ユーザーは user-store。

import "../shared/ui.css";
import * as db from "../shared/db";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import { icon, type IconName } from "../shared/icons";
import { escapeHtml, makeScopedQuery, errorMessage } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import * as Backend from "../shared/backend";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { getUser, setUserName } from "../shared/user-store";
import { currentUserId } from "../shared/identity";
import { isMemberOf } from "../shared/membership";
import { friendCandidates } from "../shared/friend-store";
import { getPayLink, setPayLink } from "../shared/payment-links";
import { currentAccount, logOut, updateName, isLoggedIn, searchAccounts, searchAccountsRemote, type Account } from "../shared/account-store";
import * as Friendships from "../shared/friendship-store";
import { isHistoryPublic, setHistoryPublic } from "../shared/history-privacy";
import { mountAppHeader } from "../shared/app-header";
import { monthCalendarHtml } from "../shared/calendar";

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
  ["[data-ic-friends]", "users"],
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
    accountEl.innerHTML = `<a href="login.html">ログイン / 新規登録</a><span>すると別端末でも同じ名前で使えます（試作）</span>`;
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
      return range ? { plan, range, color: colorFor(plan.slug, allSlugs) } : null;
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

// ---- ログイン方法（メール / LINE） --------------------------------------

const loginMethodsEl = document.querySelector<HTMLElement>("[data-login-methods]");
const loginNoteEl = document.querySelector<HTMLElement>("[data-login-note]");

function renderLoginMethods(): void {
  if (!loginMethodsEl || !loginNoteEl) return;
  if (!db.isEnabled()) {
    loginNoteEl.textContent = "この構成ではアカウント連携を使いません。";
    loginMethodsEl.innerHTML = "";
    return;
  }
  const line = db.identities().find((entry) => entry.provider === "line");
  // bootstrap は自分の認証情報だけ返すので、行があればメール登録済み。
  const hasMail = db.credentials().length > 0;
  loginNoteEl.textContent = line
    ? "LINEアカウントでログインできます。表示名はここで変えても LINE 名に戻りません。"
    : "LINEと連携すると、次回からメールアドレスの入力なしでログインできます。";
  const name = line?.display_name ? `（${escapeHtml(line.display_name)}）` : "";
  loginMethodsEl.innerHTML = line
    ? '<div class="mp-login-row"><span class="mp-login-mark">LINE</span>' +
      `<span class="mp-login-state">連携済み${name}</span>` +
      (hasMail
        ? '<button class="mp-login-act" type="button" data-line-unlink>解除する</button>'
        : '<span class="mp-login-hint">解除するには、先にメールアドレスとパスワードを登録してください</span>') +
      "</div>"
    : '<div class="mp-login-row"><span class="mp-login-mark">LINE</span>' +
      '<span class="mp-login-state">未連携</span>' +
      '<button class="mp-login-act is-primary" type="button" data-line-link>LINEと連携する</button></div>';
}

loginMethodsEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-line-link]")) {
    const url = db.lineLinkUrl(new URL("mypage.html", location.href).toString());
    if (url) location.href = url;
    return;
  }
  if (target.closest("[data-line-unlink]")) {
    if (!window.confirm("LINEでのログインを解除します。よろしいですか。")) return;
    void db.unlinkLine()
      .then(() => renderLoginMethods())
      .catch((error) => window.alert(errorMessage(error)));
  }
});

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

// ---- 友達（アカウント単位） ----------------------------------------------

const friendNoteEl = qs<HTMLElement>("[data-friend-note]");
const friendSearchForm = qs<HTMLFormElement>("[data-friend-search-form]");
const friendSearchInput = qs<HTMLInputElement>("[data-friend-search-input]");
const friendSearchResults = qs<HTMLElement>("[data-friend-search-results]");
const friendIncomingMount = qs<HTMLElement>("[data-friend-incoming]");
const friendIncomingCount = qs<HTMLElement>("[data-friend-incoming-count]");
const friendListMount = qs<HTMLElement>("[data-friend-list]");
const friendCount = qs<HTMLElement>("[data-friend-count]");
const friendOutgoingMount = qs<HTMLElement>("[data-friend-outgoing]");
const friendOutgoingCount = qs<HTMLElement>("[data-friend-outgoing-count]");
const friendTabBadge = qs<HTMLElement>("[data-friend-tab-badge]");

function friendNote(message: string): void {
  friendNoteEl.textContent = message;
}

function accountRow(account: Account, action: string): string {
  return (
    `<div class="mp-row mp-row-static">` +
    `<span class="mp-dot" style="background:#68746e"></span>` +
    `<span class="mp-row-body">` +
    `<span class="mp-row-name">${icon("user")}<span>${escapeHtml(account.name || account.email)}</span></span>` +
    `<span class="mp-row-meta">${escapeHtml(account.email)}</span>` +
    `</span>` +
    action +
    `</div>`
  );
}

function requestRow(name: string, email: string, action: string): string {
  return (
    `<div class="mp-row mp-row-static">` +
    `<span class="mp-dot" style="background:#68746e"></span>` +
    `<span class="mp-row-body">` +
    `<span class="mp-row-name">${icon("user")}<span>${escapeHtml(name)}</span></span>` +
    `<span class="mp-row-meta">${escapeHtml(email)}</span>` +
    `</span>` +
    action +
    `</div>`
  );
}

function renderFriendSearchResults(results: Account[]): void {
  if (!results.length) {
    friendSearchResults.innerHTML = "";
    return;
  }
  friendSearchResults.innerHTML = results
    .map((account) => {
      const status = Friendships.statusWith(account.id);
      const action =
        status === "friends"
          ? `<span class="mp-badge">友達</span>`
          : status === "outgoing_pending"
            ? `<span class="mp-badge">申請中</span>`
            : status === "incoming_pending"
              ? `<span class="mp-badge">申請が届いています</span>`
              : `<button type="button" class="mp-friend-btn" data-friend-request="${escapeHtml(account.id)}">${icon("plus")}申請を送る</button>`;
      return accountRow(account, action);
    })
    .join("");
}

function renderFriends(): void {
  if (!isLoggedIn()) {
    friendTabBadge.hidden = true;
    friendTabBadge.textContent = "";
    friendSearchResults.innerHTML = "";
    friendIncomingMount.innerHTML = `<div class="mp-empty"><b>ログインすると友達を追加できます</b><span>マイページ上部からログイン / 新規登録してください</span></div>`;
    friendIncomingCount.textContent = "";
    friendListMount.innerHTML = "";
    friendCount.textContent = "";
    friendOutgoingMount.innerHTML = "";
    friendOutgoingCount.textContent = "";
    friendNote("");
    return;
  }

  const incoming = Friendships.incomingRequests();
  friendTabBadge.hidden = incoming.length === 0;
  friendTabBadge.textContent = incoming.length ? String(incoming.length) : "";
  friendIncomingCount.textContent = incoming.length ? `${incoming.length}件` : "";
  friendIncomingMount.innerHTML = incoming.length
    ? incoming
        .map((row) =>
          requestRow(
            row.fromName,
            row.fromEmail,
            `<span class="mp-row-actions">` +
              `<button type="button" class="mp-friend-btn" data-friend-accept="${escapeHtml(row.id)}">${icon("check")}承諾</button>` +
              `<button type="button" class="mp-friend-btn danger" data-friend-decline="${escapeHtml(row.id)}">${icon("xMark")}拒否</button>` +
              `</span>`,
          ),
        )
        .join("")
    : `<div class="mp-empty"><b>届いている申請はありません</b></div>`;

  const friends = Friendships.listFriends();
  friendCount.textContent = friends.length ? `${friends.length}人` : "";
  friendListMount.innerHTML = friends.length
    ? friends
        .map((account) =>
          accountRow(
            account,
            `<button type="button" class="mp-friend-btn danger" data-friend-remove="${escapeHtml(account.id)}">${icon("trash")}削除</button>`,
          ),
        )
        .join("")
    : `<div class="mp-empty"><b>友達はまだいません</b><span>上の検索から友達を探して申請を送りましょう</span></div>`;

  const outgoing = Friendships.outgoingRequests();
  friendOutgoingCount.textContent = outgoing.length ? `${outgoing.length}件` : "";
  friendOutgoingMount.innerHTML = outgoing.length
    ? outgoing
        .map((row) =>
          requestRow(
            row.toName,
            row.toEmail,
            `<button type="button" class="mp-friend-btn" data-friend-cancel="${escapeHtml(row.id)}">${icon("xMark")}取り消す</button>`,
          ),
        )
        .join("")
    : "";
}

friendSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = friendSearchInput.value.trim();
  if (!query) {
    friendSearchResults.innerHTML = "";
    friendNote("");
    return;
  }
  if (!isLoggedIn()) {
    friendNote("検索するにはログインが必要です");
    return;
  }
  const results = await searchAccountsRemote(query, { excludeSelf: true });
  friendNote(results.length ? "" : "見つかりませんでした");
  renderFriendSearchResults(results);
});

function handleFriendAction(run: () => void): void {
  try {
    run();
    friendNote("");
  } catch (err) {
    friendNote(errorMessage(err) || "操作に失敗しました");
  }
  renderFriends();
  const query = friendSearchInput.value.trim();
  if (query) renderFriendSearchResults(searchAccounts(query, { excludeSelf: true }));
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const requestBtn = target.closest<HTMLButtonElement>("[data-friend-request]");
  if (requestBtn) {
    const accountId = requestBtn.dataset.friendRequest || "";
    handleFriendAction(() => Friendships.sendFriendRequest({ accountId }));
    return;
  }
  const acceptBtn = target.closest<HTMLButtonElement>("[data-friend-accept]");
  if (acceptBtn) {
    const requestId = acceptBtn.dataset.friendAccept || "";
    handleFriendAction(() => Friendships.acceptFriendRequest(requestId));
    return;
  }
  const declineBtn = target.closest<HTMLButtonElement>("[data-friend-decline]");
  if (declineBtn) {
    const requestId = declineBtn.dataset.friendDecline || "";
    handleFriendAction(() => Friendships.declineFriendRequest(requestId));
    return;
  }
  const cancelBtn = target.closest<HTMLButtonElement>("[data-friend-cancel]");
  if (cancelBtn) {
    const requestId = cancelBtn.dataset.friendCancel || "";
    handleFriendAction(() => Friendships.cancelFriendRequest(requestId));
    return;
  }
  const removeBtn = target.closest<HTMLButtonElement>("[data-friend-remove]");
  if (removeBtn) {
    const accountId = removeBtn.dataset.friendRemove || "";
    handleFriendAction(() => Friendships.removeFriend(accountId));
  }
});

// ---- 起動 ---------------------------------------------------------------

async function init(): Promise<void> {
  await Backend.preload();
  void dayKey; // 予約（将来の選択状態用）
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
window.addEventListener("trip-db-sync", (event) => {
  const detail = (event as CustomEvent<{ refreshed?: boolean; changed?: boolean }>).detail;
  if (!detail?.refreshed || !detail.changed) return;
  renderProfile();
  renderPlans();
  renderCalendar();
  renderPayLinks();
  renderFriends();
});
