// 人（メンバー名）の旅行履歴ページ。参加している計画から、行った場所（地図）・
// 旅行の記録（リスト）・カレンダーを表示する。名前は ?name= で受け取る。
// 履歴の公開/非公開は history-privacy に従う（本人は常に閲覧可）。

import "../shared/ui.css";
import * as db from "../shared/db";
import "./style.css";
import { initPageTransitions } from "../shared/page-transition";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { escapeHtml } from "../shared/dom";
import { WEEKDAYS } from "../shared/date";
import { registerServiceWorker } from "../shared/pwa";
import { mountAppHeader } from "../shared/app-header";
import { icon, type IconName } from "../shared/icons";
import { getUser } from "../shared/user-store";
import * as Backend from "../shared/backend";
import { currentAccount, searchAccountsRemote, type Account } from "../shared/account-store";
import * as Friendships from "../shared/friendship-store";
import { isHistoryPublic } from "../shared/history-privacy";
import { personTrips, historyPins, distinctPlaceCount, countriesFromPins, type PersonTrip, type HistoryPin } from "../shared/travel-history";
import { countryOf } from "../shared/country";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { planCoverThumbnail } from "../shared/cover";
import { getViews } from "../shared/views-store";
import { canEditPlan, canViewPlan, ownerNameOf } from "../shared/membership";
import { addBaseLayer } from "../shared/map-tiles";
import { monthCalendarHtml, bandColor, stepMonth } from "../shared/calendar";

// ---- 対象の名前 ---------------------------------------------------------

initPageTransitions();

const params = new URLSearchParams(location.search);
const personName = (params.get("name") || "").trim();
const personId = (params.get("user") || "").trim();

mountAppHeader({
  kicker: "Travel History",
  title: "旅行履歴",
  back: { href: "plans.html", label: "計画一覧へ戻る" },
});

registerServiceWorker();

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

// ---- 日付ユーティリティ -------------------------------------------------

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
/** 地図ラベル用の短い日付（YY/M/D）。 */
function fmtShort(d: Date): string {
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}
/** ポップアップ用の読みやすい日付（YYYY年M月D日(曜)）。 */
function fmtFull(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}

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

async function exactPersonAccounts(): Promise<Account[]> {
  const key = personName.trim().toLowerCase();
  if (!key) return [];
  const accounts = await searchAccountsRemote(personName, { excludeSelf: true });
  return accounts.filter((account) =>
    account.name.trim().toLowerCase() === key || account.email.trim().toLowerCase() === key,
  );
}

async function renderFriendAction(message = ""): Promise<void> {
  if (!friendActionEl) return;
  if (!personName) {
    friendActionEl.innerHTML = "";
    return;
  }
  const account = currentAccount();
  if (!account) {
    friendActionEl.innerHTML =
      '<a class="pv-friend-btn" href="login.html">' + icon("user") + '<span>ログインして友達申請</span></a>';
    return;
  }
  if (account.name.trim() === personName || account.email.trim().toLowerCase() === personName.toLowerCase()) {
    friendActionEl.innerHTML = '<span class="pv-friend-badge">' + icon("checkCircle") + '<span>あなたのページ</span></span>';
    return;
  }
  const matches = await exactPersonAccounts();
  if (matches.length !== 1) {
    const text = matches.length > 1 ? "同じ名前のアカウントが複数あります" : "この名前のアカウントが見つかりません";
    friendActionEl.innerHTML = '<span class="pv-friend-note">' + icon("informationCircle") + '<span>' + escapeHtml(text) + '</span></span>';
    return;
  }
  const target = matches[0];
  const status = Friendships.statusWith(target.id);
  if (status === "friends") {
    friendActionEl.innerHTML = '<span class="pv-friend-badge">' + icon("checkCircle") + '<span>友達</span></span>';
    return;
  }
  if (status === "outgoing_pending") {
    friendActionEl.innerHTML = '<span class="pv-friend-badge is-pending">' + icon("paperAirplane") + '<span>申請中</span></span>';
    return;
  }
  if (status === "incoming_pending") {
    friendActionEl.innerHTML =
      '<a class="pv-friend-btn" href="mypage.html?tab=friends">' + icon("users") + '<span>届いた申請を見る</span></a>';
    return;
  }
  friendActionEl.innerHTML =
    '<button class="pv-friend-btn" type="button" data-send-friend-request="' + escapeHtml(target.id) + '">' +
    icon("plus") + '<span>友達申請を送る</span></button>' +
    (message ? '<span class="pv-friend-message">' + escapeHtml(message) + '</span>' : "");
}

friendActionEl?.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("[data-send-friend-request]");
  if (!button) return;
  const accountId = button.dataset.sendFriendRequest || "";
  try {
    Friendships.sendFriendRequest({ accountId });
    void renderFriendAction("申請を送信しました");
  } catch (err) {
    friendActionEl.innerHTML += '<span class="pv-friend-message is-error">' +
      escapeHtml(err instanceof Error ? err.message : "送信できませんでした") + '</span>';
  }
});

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

/** 旅行の日数（開始〜終了、両端含む）。日付不明は0。 */
function tripDays(trip: PersonTrip): number {
  if (!trip.start || !trip.end) return 0;
  const s = new Date(trip.start.getFullYear(), trip.start.getMonth(), trip.start.getDate()).getTime();
  const e = new Date(trip.end.getFullYear(), trip.end.getMonth(), trip.end.getDate()).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

function renderHistory(): void {
  const trips = personTrips(personName, personId);
  allSlugs = trips.map((t) => t.plan.slug);
  allPins = historyPins(trips);
  const countries = countriesFromPins(allPins);
  const totalDays = trips.reduce((sum, t) => sum + tripDays(t), 0);

  // 統計バンド
  if (statsEl) statsEl.hidden = false;
  const set = (sel: string, value: number): void => {
    const el = $(sel);
    if (el) el.textContent = String(value);
  };
  set("[data-country-count]", countries.length);
  set("[data-trip-count]", trips.length);
  set("[data-place-count]", distinctPlaceCount(trips));
  set("[data-day-count]", totalDays);

  // 国旗ストリップ
  const flagsEl = $("[data-flags]");
  if (flagsEl) {
    flagsEl.hidden = !countries.length;
    flagsEl.innerHTML = countries
      .map((c) => `<span class="pv-flag" title="${escapeHtml(c.name)}（${c.count}か所）">${c.flag}</span>`)
      .join("");
  }

  renderMap();
  renderCreatedPlans();
  renderTrips(trips);
  renderCalendar(trips, allSlugs);
}

function samePerson(a: string | undefined, b: string): boolean {
  return String(a || "").trim().toLowerCase() === b.trim().toLowerCase();
}

function planCreatorName(meta: PlanMeta): string {
  return ownerNameOf(meta);
}

function isCreatedByPerson(meta: PlanMeta): boolean {
  return samePerson(planCreatorName(meta), personName);
}

function canShowCreatedPlan(meta: PlanMeta): boolean {
  if (!TripPlans.isPublished(meta) && !canEditPlan(meta)) return false;
  return canViewPlan(meta);
}

function createdPlanLocations(meta: PlanMeta, max = 3): string {
  const data = TripPlans.getData(meta.slug);
  const names = [
    ...(data?.cities || []).map((city) => city.name || ""),
    ...(data?.itinerary || []).map((item) => item.area || item.place || ""),
    meta.route || "",
  ].flatMap((raw) => TripPlans.splitRouteLocations(raw));
  return Array.from(new Set(names)).slice(0, max).join("、");
}

function createdPlanSortValue(meta: PlanMeta): number {
  const value = meta.updatedAt || meta.createdAt || "";
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function renderCreatedPlans(): void {
  const mount = $("[data-created-plans]");
  const panel = $("[data-created-panel]");
  const countEl = $("[data-created-count]");
  if (!mount) return;

  const plans = TripPlans.list()
    .filter((meta) => isCreatedByPerson(meta) && canShowCreatedPlan(meta))
    .sort((a, b) => createdPlanSortValue(b) - createdPlanSortValue(a));

  if (countEl) countEl.textContent = plans.length ? `${plans.length}件` : "";
  if (!plans.length) {
    if (panel) panel.hidden = true;
    mount.innerHTML = "";
    return;
  }
  if (panel) panel.hidden = false;

  mount.innerHTML = plans.map((meta) => {
    const locations = createdPlanLocations(meta);
    const views = getViews(meta.slug);
    const href = `index.html?plan=${encodeURIComponent(meta.slug)}${canEditPlan(meta) ? "" : "&view=1"}`;
    const cover = planCoverThumbnail(meta);
    return (
      `<a class="pv-created-card" href="${escapeHtml(href)}">` +
      `<span class="pv-created-cover"><img src="${escapeHtml(cover)}" alt="${escapeHtml(meta.title || "旅行画像")}" loading="lazy"><span class="pv-created-views">${icon("eye")}<span>${views.toLocaleString("ja-JP")}</span></span></span>` +
      `<span class="pv-created-body">` +
      `<span class="pv-created-title">${escapeHtml(meta.title || "無題の旅行")}</span>` +
      `<span class="pv-created-meta">` +
      (meta.dates ? `<span>${icon("calendarDays")}${escapeHtml(meta.dates)}</span>` : "") +
      (locations ? `<span>${icon("mapPin")}${escapeHtml(locations)}</span>` : "") +
      `</span>` +
      `</span>` +
      `</a>`
    );
  }).join("");
}

// ---- 地図（行った場所。期間フィルター付き） ----------------------------

let personMap: L.Map | null = null;
let markersLayer: L.LayerGroup | null = null;
let allPins: HistoryPin[] = [];
let allSlugs: string[] = [];
let filterMonths = 0; // 0 = 全期間

/** filterMonths に基づき、過去N ヶ月以内に訪れたピンだけに絞る（0 は全件）。 */
function filteredPins(): HistoryPin[] {
  if (filterMonths <= 0) return allPins;
  const cutoff = new Date(today.getFullYear(), today.getMonth() - filterMonths, today.getDate());
  return allPins.filter((p) => p.date && p.date.getTime() >= cutoff.getTime());
}

/** ピンをタップしたときの詳細（どの旅行で・いつ・前後どこへ）。 */
function pinPopupHtml(pin: HistoryPin): string {
  const country = countryOf(pin.lat, pin.lng);
  const flag = country ? `<span class="pv-pop-flag">${country.flag}</span>` : "";
  const visits = pin.visits
    .map((v) => {
      const dateStr = v.date ? fmtFull(v.date) : "日付不明";
      const prev = v.prevPlace ? `${escapeHtml(v.prevPlace)} から　` : "";
      const next = v.nextPlace
        ? `<span class="pv-pop-next">→ 次は ${escapeHtml(v.nextPlace)}</span>`
        : `この旅行の最後の訪問地`;
      return (
        `<div class="pv-pop-visit">` +
        `<div class="pv-pop-trip">${escapeHtml(v.tripTitle)}</div>` +
        `<div class="pv-pop-date">${escapeHtml(dateStr)}</div>` +
        `<div class="pv-pop-seq">${prev}${next}</div>` +
        `</div>`
      );
    })
    .join("");
  return `<div class="pv-pop"><div class="pv-pop-place">${flag}${escapeHtml(pin.place)}</div>${visits}</div>`;
}

function renderMap(): void {
  const mapEl = $("[data-map]");
  if (!mapEl) return;

  const filterEl = $<HTMLSelectElement>("[data-map-filter]");
  if (filterEl) {
    filterEl.hidden = !allPins.length;
    filterEl.addEventListener("change", () => {
      filterMonths = Number(filterEl.value) || 0;
      updateMapMarkers();
    });
  }

  if (!allPins.length) {
    mapEl.innerHTML = `<div class="pv-empty"><b>地図データがありません</b><span>行程に場所が登録されると地図に表示されます</span></div>`;
    return;
  }

  personMap = L.map(mapEl, { scrollWheelZoom: false, attributionControl: true });
  addBaseLayer(L, personMap);
  markersLayer = L.layerGroup().addTo(personMap);
  updateMapMarkers();
}

function updateMapMarkers(): void {
  const countEl = $("[data-map-count]");
  if (!personMap || !markersLayer) return;
  const pins = filteredPins();
  if (countEl) {
    countEl.textContent = pins.length ? `${pins.length}地点` : filterMonths > 0 ? "該当なし" : "";
  }

  markersLayer.clearLayers();
  const latlngs: L.LatLngExpression[] = [];
  pins.forEach((pin) => {
    latlngs.push([pin.lat, pin.lng]);
    const marker = L.circleMarker([pin.lat, pin.lng], {
      radius: 6,
      color: "#fff",
      weight: 1.5,
      fillColor: "#111916",
      fillOpacity: 1,
    })
      .addTo(markersLayer as L.LayerGroup)
      .bindPopup(pinPopupHtml(pin), { minWidth: 190, maxWidth: 260 });
    // 訪問日を常時ラベル表示（最新訪問日）。
    if (pin.date) {
      marker.bindTooltip(fmtShort(pin.date), { permanent: true, direction: "top", className: "pv-map-date", offset: [0, -6] });
    }
  });

  if (latlngs.length === 1) personMap.setView(latlngs[0], 9);
  else if (latlngs.length > 1) personMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] });
}

// ---- 旅行の記録（リスト） -----------------------------------------------

/** その旅行で訪れた国の国旗（重複なし・訪問順）。 */
function tripFlags(trip: PersonTrip): string {
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const pt of trip.points) {
    const c = countryOf(pt.lat, pt.lng);
    if (c && !seen.has(c.name)) {
      seen.add(c.name);
      flags.push(c.flag);
    }
  }
  return flags.join("");
}

/** その旅行の年（開始日、無ければ日程文字列の西暦）。 */
function tripYear(trip: PersonTrip): string {
  if (trip.start) return String(trip.start.getFullYear());
  const m = /(\d{4})/.exec(String(trip.plan.dates || ""));
  return m ? m[1] : "—";
}

function fmtMonthDay(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

function tripDateRange(trip: PersonTrip): string {
  if (!trip.start) return String(trip.plan.dates || "日付未定");
  if (!trip.end || sameDay(trip.start, trip.end)) return fmtMonthDay(trip.start);
  if (trip.start.getMonth() === trip.end.getMonth()) {
    return `${fmtMonthDay(trip.start)}-${trip.end.getDate()}(${WEEKDAYS[trip.end.getDay()]})`;
  }
  return `${fmtMonthDay(trip.start)}-${fmtMonthDay(trip.end)}`;
}

function renderTrips(trips: PersonTrip[]): void {
  const listEl = $("[data-trips]");
  const countEl = $("[data-trips-count]");
  if (countEl) countEl.textContent = trips.length ? `${trips.length}件` : "";
  if (!listEl) return;

  if (!trips.length) {
    listEl.innerHTML = `<div class="pv-empty"><b>まだ旅行がありません</b><span>${escapeHtml(personName)}さんが参加している計画がここに並びます</span></div>`;
    return;
  }

  const groups = new Map<string, PersonTrip[]>();
  for (const trip of trips) {
    const year = tripYear(trip);
    groups.set(year, [...(groups.get(year) || []), trip]);
  }

  listEl.innerHTML = Array.from(groups.entries())
    .map(([year, yearTrips]) => {
      const rows = yearTrips
        .map((trip) => {
          const days = tripDays(trip);
          const flags = tripFlags(trip);
          const route = trip.places.join("・");
          return (
            `<a class="pv-trip" href="index.html?plan=${encodeURIComponent(trip.plan.slug)}">` +
            `<span class="pv-trip-date">${icon("calendarDays")}${escapeHtml(tripDateRange(trip))}</span>` +
            `<span class="pv-trip-main">` +
            `<span class="pv-trip-name">${escapeHtml(trip.plan.title || "無題の旅行")}` +
            (flags ? `<span class="pv-trip-flags">${flags}</span>` : "") +
            `</span>` +
            `<span class="pv-trip-meta">` +
            (route ? `<span>${icon("mapPin")}${escapeHtml(route)}</span>` : "") +
            (days ? `<span>${icon("clock")}${days}日</span>` : "") +
            `</span>` +
            `</span>` +
            `<span class="pv-trip-open">${icon("chevronRight")}</span>` +
            `</a>`
          );
        })
        .join("");
      return `<section class="pv-trip-year-group"><h3 class="pv-trip-year">${escapeHtml(year)}</h3><div class="pv-trip-year-list">${rows}</div></section>`;
    })
    .join("");
}

// ---- カレンダー（旅行期間の帯） -----------------------------------------

interface Band { plan: PersonTrip["plan"]; start: Date; end: Date; color: string }

const today = new Date();
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
  await renderFriendAction();
  boot();
}

void db.load().then(init);

// 控え（キャッシュ）で先に描いているので、裏の取り直しで中身が変わったら描き直す。
db.onDbSync(() => void init());
