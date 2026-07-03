// 人（メンバー名）の旅行履歴ページ。参加している計画から、行った場所（地図）・
// 旅行の記録（リスト）・カレンダーを表示する。名前は ?name= で受け取る。
// 履歴の公開/非公開は history-privacy に従う（本人は常に閲覧可）。

import "../shared/ui.css";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { escapeHtml } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import { mountAppHeader } from "../shared/app-header";
import { getUser } from "../shared/user-store";
import { isHistoryPublic } from "../shared/history-privacy";
import { personTrips, historyPins, distinctPlaceCount, countriesFromPins, type PersonTrip, type HistoryPin } from "../shared/travel-history";
import { countryOf } from "../shared/country";

// ---- 対象の名前 ---------------------------------------------------------

const params = new URLSearchParams(location.search);
const personName = (params.get("name") || "").trim();

mountAppHeader({
  kicker: "Travel History",
  title: "旅行履歴",
  back: { href: "plans.html", label: "計画一覧へ戻る" },
});

registerServiceWorker();

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.querySelector<T>(sel);

// ---- 配色（計画ごとに一意の色。カレンダーの帯のみで使う） --------------

const PALETTE = ["#0b5a42", "#22719d", "#b87418", "#6246a6", "#cf4f3d", "#2f7d6b", "#8a5a2b", "#3b4c8a"];
function colorFor(slug: string, allSlugs: string[]): string {
  const i = allSlugs.indexOf(slug);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

// ---- 日付ユーティリティ -------------------------------------------------

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
/** 地図ラベル用の短い日付（YY/M/D）。 */
function fmtShort(d: Date): string {
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}
/** ポップアップ用の読みやすい日付（YYYY年M月D日(曜)）。 */
function fmtFull(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${DOW[d.getDay()]})`;
}

// ---- 起動 ---------------------------------------------------------------

const nameEl = $("[data-name]");
const statsEl = $("[data-stats]");
const privateEl = $("[data-private]");
const contentEl = $("[data-content]");

const me = getUser().name.trim();
const isSelf = Boolean(me) && me === personName;

if (nameEl) {
  nameEl.innerHTML =
    escapeHtml(personName || "名前が指定されていません") +
    (isSelf ? `<span class="pv-self">あなた</span>` : "");
}
document.title = `${personName || "旅行履歴"} | 旅行計画`;

const canView = Boolean(personName) && (isSelf || isHistoryPublic(personName));

// 実際の描画はファイル末尾の boot() で行う。
// renderMap/renderCalendar が参照するモジュール変数（allPins, today, view など）が
// この位置より下で宣言されるため、ここで直接呼ぶと TDZ 参照エラーになる。
function boot(): void {
  if (!canView) {
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
  const trips = personTrips(personName);
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
  renderTrips(trips);
  renderCalendar(trips, allSlugs);
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
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "&copy; OpenStreetMap",
  }).addTo(personMap);
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

function renderTrips(trips: PersonTrip[]): void {
  const listEl = $("[data-trips]");
  const countEl = $("[data-trips-count]");
  if (countEl) countEl.textContent = trips.length ? `${trips.length}件` : "";
  if (!listEl) return;

  if (!trips.length) {
    listEl.innerHTML = `<div class="pv-empty"><b>まだ旅行がありません</b><span>${escapeHtml(personName)}さんが参加している計画がここに並びます</span></div>`;
    return;
  }

  listEl.innerHTML = trips
    .map((trip) => {
      const days = tripDays(trip);
      const flags = tripFlags(trip);
      const route = trip.places.join("・");
      return (
        `<a class="pv-trip" href="index.html?plan=${encodeURIComponent(trip.plan.slug)}">` +
        `<span class="pv-trip-year">${escapeHtml(tripYear(trip))}</span>` +
        `<span class="pv-trip-main">` +
        `<span class="pv-trip-name">${escapeHtml(trip.plan.title || "無題の旅行")}` +
        (flags ? `<span class="pv-trip-flags">${flags}</span>` : "") +
        `</span>` +
        (route ? `<span class="pv-trip-route">${escapeHtml(route)}</span>` : "") +
        `</span>` +
        (days ? `<span class="pv-trip-days">${days}日</span>` : "") +
        `</a>`
      );
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
    .map((t) => ({ plan: t.plan, start: t.start, end: t.end, color: colorFor(t.plan.slug, allSlugs) }));

  // 直近の旅行がある月を初期表示にする。
  if (bands.length) {
    const latest = bands.reduce((a, b) => (b.start.getTime() > a.start.getTime() ? b : a));
    view.year = latest.start.getFullYear();
    view.month = latest.start.getMonth();
  }
  drawCalendar();
}

function covers(band: Band, d: Date): boolean {
  const t = d.getTime();
  const s = new Date(band.start.getFullYear(), band.start.getMonth(), band.start.getDate()).getTime();
  const e = new Date(band.end.getFullYear(), band.end.getMonth(), band.end.getDate()).getTime();
  return t >= s && t <= e;
}

function drawCalendar(): void {
  const calEl = $("[data-cal]");
  const titleEl = $("[data-cal-title]");
  if (titleEl) titleEl.textContent = `${view.year}年${view.month + 1}月`;
  if (!calEl) return;

  const first = new Date(view.year, view.month, 1);
  const gridStart = new Date(view.year, view.month, 1 - first.getDay());

  let html = DOW.map((d, i) => `<div class="pv-cal-dow${i === 0 ? " sun" : i === 6 ? " sat" : ""}">${d}</div>`).join("");

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
        const cls = `pv-bar${contL ? " cont-l" : ""}${contR ? " cont-r" : ""}`;
        return `<a class="${cls}" href="index.html?plan=${encodeURIComponent(b.plan.slug)}" style="background:${b.color}" title="${escapeHtml(b.plan.title || "")}">${label}</a>`;
      })
      .join("");
    const more = dayBands.length > shown.length ? `<span class="pv-bar-more">+${dayBands.length - shown.length}</span>` : "";

    html +=
      `<div class="pv-cell${out ? " is-out" : ""}${isToday ? " is-today" : ""}">` +
      `<span class="pv-cell-n">${d.getDate()}</span>` +
      `<span class="pv-cell-bars">${bars}${more}</span>` +
      `</div>`;
  }
  calEl.innerHTML = html;
}

$("[data-cal-prev]")?.addEventListener("click", () => {
  view.month -= 1;
  if (view.month < 0) { view.month = 11; view.year -= 1; }
  drawCalendar();
});
$("[data-cal-next]")?.addEventListener("click", () => {
  view.month += 1;
  if (view.month > 11) { view.month = 0; view.year += 1; }
  drawCalendar();
});

// 全モジュール変数の宣言後に描画を開始する。
boot();
