// 人（メンバー名）の旅行履歴ページ。参加している計画から、行った場所（地図）・
// 旅行の記録（リスト）・カレンダーを表示する。名前は ?name= で受け取る。
// 履歴の公開/非公開は history-privacy に従う（本人は常に閲覧可）。

import "../shared/ui.css";
import * as db from "../shared/db";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import { escapeHtml } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import { mountAppHeader } from "../shared/app-header";
import { icon, type IconName } from "../shared/icons";
import { getUser } from "../shared/user-store";
import * as Backend from "../shared/backend";
import { currentAccount } from "../shared/account-store";
import { isHistoryPublic } from "../shared/history-privacy";
import { personTrips, historyPins, type PersonTrip } from "../shared/travel-history";
import { monthCalendarHtml, bandColor, stepMonth } from "../shared/calendar";
import { personName, personId, $, today } from "./context";
import { renderFriendAction, handleFriendActionClick } from "./friend-action";
import { renderCreatedPlans } from "./created-plans";
import { renderStats } from "./stats";
import { renderMap } from "./history-map";
import { renderTrips } from "./trip-list";

// ---- 対象の名前 ---------------------------------------------------------

initPageTransitions();

mountAppHeader({
  kicker: "Travel History",
  title: "旅行履歴",
  back: { href: "plans.html", label: "計画一覧へ戻る" },
});

registerServiceWorker();

// ---- 起動 ---------------------------------------------------------------

const nameEl = $("[data-name]");
const avatarEl = $("[data-avatar]");
const statsEl = $("[data-stats]");
const privateEl = $("[data-private]");
const contentEl = $("[data-content]");
const friendActionEl = $("[data-friend-action]");

document.querySelectorAll<HTMLElement>("[data-stat-icon]").forEach((stat) => {
  const name = stat.dataset.statIcon as IconName | undefined;
  const slot = stat.querySelector<HTMLElement>(".pv-stat-icon");
  if (name && slot) slot.innerHTML = icon(name, { strokeWidth: 1.7 });
});

const me = getUser().name.trim();
const isSelf = personId ? currentAccount()?.id === personId : Boolean(me) && me === personName;

if (nameEl) {
  nameEl.innerHTML =
    escapeHtml(personName || "名前が指定されていません") +
    (isSelf ? `<span class="pv-self">あなた</span>` : "");
}
if (avatarEl) {
  avatarEl.textContent = personName ? personName.slice(0, 1) : "?";
}
document.title = `${personName || "旅行履歴"} | 旅行計画`;

function canViewHistory(): boolean {
  return Boolean(personName) && (isSelf || isHistoryPublic(personId || personName));
}

friendActionEl?.addEventListener("click", (event) => handleFriendActionClick(friendActionEl, event));

// 実際の描画はファイル末尾の boot() で行う。
// renderMap/renderCalendar が参照するモジュール変数（allPins, today, view など）が
// この位置より下で宣言されるため、ここで直接呼ぶと TDZ 参照エラーになる。
function boot(): void {
  if (!canViewHistory()) {
    if (privateEl) privateEl.hidden = false;
    if (contentEl) contentEl.hidden = true;
    if (!personName && privateEl) {
      privateEl.innerHTML = `<b>名前が指定されていません</b><span>メンバーのアイコンから開いてください。</span>`;
    }
    return;
  }
  if (privateEl) privateEl.hidden = true;
  if (contentEl) contentEl.hidden = false;
  renderHistory();
}

function renderHistory(): void {
  const trips = personTrips(personName, personId);
  const allSlugs = trips.map((t) => t.plan.slug);
  const allPins = historyPins(trips);

  renderStats(statsEl, trips, allPins);
  renderMap(allPins);
  renderCreatedPlans();
  renderTrips(trips);
  renderCalendar(trips, allSlugs);
}

// ---- カレンダー（旅行期間の帯） -----------------------------------------

interface Band { plan: PersonTrip["plan"]; start: Date; end: Date; color: string }

const view = { year: today.getFullYear(), month: today.getMonth() };
let bands: Band[] = [];

function renderCalendar(trips: PersonTrip[], allSlugs: string[]): void {
  bands = trips
    .filter((t): t is PersonTrip & { start: Date; end: Date } => Boolean(t.start && t.end))
    .map((t) => ({ plan: t.plan, start: t.start, end: t.end, color: bandColor(t.plan.slug, allSlugs) }));

  // 直近の旅行がある月を初期表示にする。
  if (bands.length) {
    const latest = bands.reduce((a, b) => (b.start.getTime() > a.start.getTime() ? b : a));
    view.year = latest.start.getFullYear();
    view.month = latest.start.getMonth();
  }
  drawCalendar();
}

function drawCalendar(): void {
  const calEl = $("[data-cal]");
  const titleEl = $("[data-cal-title]");
  if (titleEl) titleEl.textContent = `${view.year}年${view.month + 1}月`;
  if (!calEl) return;

  calEl.innerHTML = monthCalendarHtml({
    year: view.year,
    month: view.month,
    today,
    classPrefix: "pv",
    bands: bands.map((band) => ({
      slug: band.plan.slug,
      title: band.plan.title || "旅行",
      start: band.start,
      end: band.end,
      color: band.color,
    })),
  });
}

$("[data-cal-prev]")?.addEventListener("click", () => { stepMonth(view, -1); drawCalendar(); });
$("[data-cal-next]")?.addEventListener("click", () => { stepMonth(view, 1); drawCalendar(); });

// 全モジュール変数の宣言後に描画を開始する。
async function init(): Promise<void> {
  await Backend.preload();
  await renderFriendAction(friendActionEl);
  boot();
}

void db.load().then(init);

// 控え（キャッシュ）で先に描いているので、裏の取り直しで中身が変わったら描き直す。
db.onDbSync(() => void init());
