// 旅行計画一覧（プランハブ）ページ。docs/plans.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// プランの一覧表示・検索・開く/編集/複製/削除を行う。

import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { LocalPlanData, PlanMeta, PlanSource } from "../shared/plans-store";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml, errorMessage, makeScopedQuery } from "../shared/dom";
import { mdLabel } from "../shared/date";
import { mapsSearchUrl } from "../shared/maps";
import { planDashboardHref } from "../shared/plan-url";
import { registerServiceWorker } from "../shared/pwa";
import { icon, type IconName } from "../shared/icons";
import { mountAppHeader } from "../shared/app-header";
import { getViews } from "../shared/views-store";
import { planCoverThumbnail } from "../shared/cover";
import { splitNames } from "../shared/friend-store";
import { decodeInvite } from "../shared/invite";
import { isIdentified, currentUserId } from "../shared/identity";
import { canEditPlan, ownerNameOf, roleLabel, roleOf } from "../shared/membership";
import { addBaseLayer } from "../shared/map-tiles";

// ---- 補助型 -------------------------------------------------------------

initPageTransitions();

interface AppState {
  filter: string;
  selectedLocation: string;
  selectedPlanSlug: string;
}

type PlanTiming = "current" | "upcoming" | "past" | "undated";
type LocationTransition = "forward" | "back" | "swap";

interface LocationEntry {
  name: string;
  coords?: L.LatLngTuple;
}

interface DestinationRow {
  name: string;
  count: number;
  coords?: L.LatLngTuple;
}

// ---- DOM 取得ヘルパー ----------------------------------------------------

mountAppHeader({
  kicker: "Travel Plans",
  title: "旅行計画",
  meta: [],
  mobileFixed: true,
  actions: [
    { kind: "button", display: "icon", icon: "magnifyingGlass", label: "計画を検索", attr: "data-toggle-search" },
    { kind: "link", display: "icon", icon: "user", label: "マイページ", href: "mypage.html" },
  ],
});

const { qs } = makeScopedQuery(document);

const hub = qs<HTMLElement>(".hub");
const gridMine = qs<HTMLElement>("[data-grid-mine]");
const gridPublic = qs<HTMLElement>("[data-grid-public]");
const discoverSectionEl = qs<HTMLElement>("[data-discover-section]");
const toolbarEl = qs<HTMLElement>("[data-hub-toolbar]");
const mineHeadEl = qs<HTMLElement>("[data-mine-head]");
const publicHead = qs<HTMLElement>("[data-public-head]");
const countEl = document.querySelector<HTMLElement>("[data-count]");
const countMineEl = qs<HTMLElement>("[data-count-mine]");
const countPublicEl = qs<HTMLElement>("[data-count-public]");
const filterEl = qs<HTMLInputElement>("[data-filter]");
const searchToggleEl = qs<HTMLButtonElement>("[data-toggle-search]");
const createMainEl = qs<HTMLAnchorElement>("[data-create-main]");
const inviteStripEl = qs<HTMLElement>("[data-invite-strip]");
const inviteTitleEl = qs<HTMLElement>("[data-invite-title]");
const inviteNoteEl = qs<HTMLElement>("[data-invite-note]");
const rankingNewEl = qs<HTMLElement>("[data-ranking-new]");
const rankingViewsEl = qs<HTMLElement>("[data-ranking-views]");
const destinationsEl = qs<HTMLElement>("[data-destinations]");
const locationExplorerEl = qs<HTMLElement>(".location-explorer");
const locationSideEl = qs<HTMLElement>(".location-side");
const locationHeadEl = qs<HTMLElement>("[data-location-head]");
const locationPlansEl = qs<HTMLElement>("[data-location-plans]");
const locationScheduleEl = qs<HTMLElement>("[data-location-schedule]");
const mapBoardEl = qs<HTMLElement>("[data-map-board]");
const newCountEl = qs<HTMLElement>("[data-new-count]");
const viewsTotalEl = qs<HTMLElement>("[data-views-total]");
const destinationCountEl = qs<HTMLElement>("[data-destination-count]");
const mapCountEl = qs<HTMLElement>("[data-map-count]");
const state: AppState = { filter: "", selectedLocation: "", selectedPlanSlug: "" };
let pendingLocationTransition: LocationTransition | "" = "";
let locationTransitionTimer = 0;
let lastRankingLimit = 0;
let rankingResizeTimer = 0;
const locationMapState: { map: L.Map | null; layer: L.LayerGroup | null } = { map: null, layer: null };

// セクション見出しの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
document.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.insertAdjacentHTML("afterbegin", icon(name as IconName));
});

function setSearchOpen(open: boolean): void {
  hub.classList.toggle("is-search-open", open);
  searchToggleEl.setAttribute("aria-expanded", String(open));
  if (open) window.setTimeout(() => filterEl.focus(), 0);
}

searchToggleEl.setAttribute("aria-expanded", "false");
searchToggleEl.addEventListener("click", () => {
  setSearchOpen(!hub.classList.contains("is-search-open"));
});

const SOURCE_LABEL: Record<string, string> = {
  local: "ローカル",
  sample: "サンプル",
};

const EMPTY_TRIP_COVERS = [
  "./images/thumbs/cover_tokyo.webp",
  "./images/thumbs/cover_newyork.webp",
  "./images/thumbs/cover_africa.webp",
  "./images/thumbs/cover_india.webp",
  "./images/thumbs/cover_arizona.webp",
];

const emptyTripCover = EMPTY_TRIP_COVERS[Math.floor(Math.random() * EMPTY_TRIP_COVERS.length)];

function sourceClass(source: PlanSource | string): string {
  return source === "local" || source === "sample" ? source : "local";
}

function planText(meta: PlanMeta): string {
  return [meta.title, locationLabel(meta), meta.route, meta.dates, meta.members, creatorName(meta)].join(" ").toLowerCase();
}

function planHref(meta: PlanMeta, view = false): string {
  return planDashboardHref(meta.slug, { view });
}

function timeValue(meta: PlanMeta): number {
  const value = meta.updatedAt || meta.createdAt || "";
  const t = value ? Date.parse(value) : 0;
  return Number.isFinite(t) ? t : 0;
}

function dayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function parseLooseDate(token: string, fallbackYear?: number): Date | null {
  const match = token.match(/(?:(\d{4})[\/.-])?\s*(\d{1,2})[\/.-](\d{1,2})/);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : fallbackYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateRange(meta: PlanMeta): { start: number; end: number } | null {
  const raw = String(meta.dates || "");
  if (!raw.trim()) return null;
  const parts = raw.split(/\s*(?:-|–|—|〜|~|から|to)\s*/).filter(Boolean);
  const startDate = parseLooseDate(parts[0] || raw);
  if (!startDate) return null;
  const endDate = parseLooseDate(parts[1] || "", startDate.getFullYear()) || startDate;
  return { start: dayStart(startDate), end: dayStart(endDate) };
}

function planTiming(meta: PlanMeta, today = dayStart(new Date())): { kind: PlanTiming; distance: number } {
  const range = dateRange(meta);
  if (!range) return { kind: "undated", distance: Number.POSITIVE_INFINITY };
  if (range.start <= today && today <= range.end) return { kind: "current", distance: 0 };
  if (today < range.start) return { kind: "upcoming", distance: range.start - today };
  return { kind: "past", distance: today - range.end };
}

function sortMinePlans(plans: PlanMeta[]): PlanMeta[] {
  const rank: Record<PlanTiming, number> = { current: 0, upcoming: 1, undated: 2, past: 3 };
  return [...plans].sort((a, b) => {
    const ta = planTiming(a);
    const tb = planTiming(b);
    if (rank[ta.kind] !== rank[tb.kind]) return rank[ta.kind] - rank[tb.kind];
    if (ta.distance !== tb.distance) return ta.distance - tb.distance;
    return timeValue(b) - timeValue(a);
  });
}

function highlightedMineSlugs(plans: PlanMeta[]): Map<string, PlanTiming> {
  const result = new Map<string, PlanTiming>();
  plans.forEach((meta) => {
    if (planTiming(meta).kind === "current") result.set(meta.slug, "current");
  });
  if (!result.size) {
    const next = plans.find((meta) => planTiming(meta).kind === "upcoming");
    if (next) result.set(next.slug, "upcoming");
  }
  return result;
}

function emptyList(message: string): string {
  return '<div class="hub-empty" style="border:0;background:#fff;padding:24px 14px;">' + escapeHtml(message) + "</div>";
}

function routeParts(meta: PlanMeta): string[] {
  const source = [meta.route, meta.title].filter(Boolean).join("、");
  return TripPlans.splitRouteLocations(source).slice(0, 8);
}

function destinationName(meta: PlanMeta): string {
  const parts = routeParts(meta);
  if (parts[0]) return parts[0];
  return meta.title.replace(/旅行|計画|ダッシュボード/g, "").trim() || "行き先未定";
}

const LOCATION_ALIASES: [RegExp, string][] = [
  [/羽田|成田|東京駅|品川|新宿|マンハッタン|リバティ島/i, "東京"],
  [/関西国際空港|伊丹|新大阪/i, "大阪"],
  [/京都駅/i, "京都"],
  [/博多/i, "福岡"],
  [/ホノルル/i, "ハワイ"],
  [/london\s*hotel/i, "ロンドン"],
  [/ベルリン|ドイツ/i, "ドイツ"],
  [/バルセロナ|マドリード/i, "スペイン"],
  [/デリー/i, "インド"],
  [/ウランバートル/i, "モンゴル"],
  [/台北/i, "台湾"],
];

function displayLocationName(name: string): string {
  const raw = String(name || "").trim();
  const hit = LOCATION_ALIASES.find(([pattern]) => pattern.test(raw));
  if (hit) return hit[1];
  return raw
    .replace(/国際?空港|空港|駅|ホテル|hotel/gi, "")
    .replace(/\s+/g, " ")
    .trim() || raw;
}

function numeric(value: number | string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const planDataCache = new Map<string, LocalPlanData | null>();

function dataForPlan(meta: PlanMeta): LocalPlanData | null {
  if (!planDataCache.has(meta.slug)) {
    planDataCache.set(meta.slug, TripPlans.getData(meta.slug));
  }
  return planDataCache.get(meta.slug) || null;
}

function uniqueLocationEntries(entries: LocationEntry[]): LocationEntry[] {
  const byName = new Map<string, LocationEntry>();
  entries.forEach((entry) => {
    const name = displayLocationName(entry.name);
    if (!name) return;
    const existing = byName.get(name);
    if (!existing || (!existing.coords && entry.coords)) byName.set(name, { name, coords: entry.coords });
  });
  return [...byName.values()];
}

function locationEntries(meta: PlanMeta): LocationEntry[] {
  const data = dataForPlan(meta);
  const entries: LocationEntry[] = (data?.cities || [])
    .map((city) => {
      const lat = numeric(city.lat);
      const lng = numeric(city.lng);
      return {
        name: city.name || "",
        coords: lat !== null && lng !== null ? [lat, lng] as L.LatLngTuple : undefined,
      };
    });

  entries.push(...(data?.itinerary || []).map((item) => ({ name: item.area || "" })));
  entries.push(...routeParts(meta).map((name) => ({ name })));

  const unique = uniqueLocationEntries(entries);
  return unique.length ? unique : uniqueLocationEntries([{ name: destinationName(meta) }]);
}

function locationNames(meta: PlanMeta): string[] {
  return locationEntries(meta).map((entry) => entry.name);
}

function locationLabel(meta: PlanMeta): string {
  return locationNames(meta).join("、") || meta.route || destinationName(meta);
}

function compactLocationLabel(meta: PlanMeta, max = 3): string {
  const names = locationNames(meta).slice(0, max);
  return names.join("、") || meta.route || destinationName(meta);
}

function creatorName(meta: PlanMeta): string {
  return ownerNameOf(meta) || splitNames(meta.members)[0] || "作成者不明";
}

function personHref(name: string): string {
  return "person.html?name=" + encodeURIComponent(name);
}

function creatorLinkHtml(meta: PlanMeta, className: string): string {
  const name = creatorName(meta);
  const isUnknown = name === "作成者不明";
  const linkAttrs = isUnknown
    ? ""
    : ' role="link" tabindex="0" data-author-link="' + escapeHtml(personHref(name)) + '" aria-label="' + escapeHtml(name + "の人物ページを開く") + '"';
  return (
    '<span class="' + className + (isUnknown ? " is-unknown" : "") + '"' + linkAttrs + ">" +
    icon("user") +
    "<span>" + escapeHtml(name) + "</span></span>"
  );
}

function rankingCardLimit(): number {
  const width = Math.max(
    rankingNewEl.clientWidth,
    rankingViewsEl.clientWidth,
    Math.min(window.innerWidth, 1600) - 48,
  );
  const cardWidth = window.innerWidth <= 600 ? 180 : 220;
  const gap = window.innerWidth <= 600 ? 12 : 18;
  return Math.max(5, Math.min(12, Math.ceil((width + gap) / (cardWidth + gap))));
}

function renderRankings(plans: PlanMeta[]): void {
  const limit = rankingCardLimit();
  lastRankingLimit = limit;
  const latest = [...plans].sort((a, b) => timeValue(b) - timeValue(a)).slice(0, limit);
  const byViews = [...plans].sort((a, b) => getViews(b.slug) - getViews(a.slug) || timeValue(b) - timeValue(a)).slice(0, limit);
  // 新着・ランキングも「自分の計画」と同じカードを使う。
  // 以前は discover-trip-card という別実装で、同じ旅行計画なのに
  // 画像サイズ・文字サイズ・情報の並びが揃っていなかった。
  const discoverCard = (meta: PlanMeta, label: string): string =>
    rowHtml(meta, "public", "", undefined, label);

  rankingNewEl.innerHTML = latest.length
    ? latest.map((meta, i) => discoverCard(meta, "NEW " + String(i + 1).padStart(2, "0"))).join("")
    : emptyList("公開旅行はまだありません。最初の旅行を作って公開できます。");
  rankingViewsEl.innerHTML = byViews.length
    ? byViews.map((meta, i) => discoverCard(meta, "No." + String(i + 1) + " / " + getViews(meta.slug).toLocaleString("ja-JP") + " views")).join("")
    : emptyList("観覧数ランキングは、公開旅行が閲覧されると表示されます。");
  newCountEl.textContent = latest.length ? latest.length + "件" : "";
  const totalViews = plans.reduce((sum, meta) => sum + getViews(meta.slug), 0);
  viewsTotalEl.textContent = totalViews ? totalViews.toLocaleString("ja-JP") + " views" : "";
}

function hasLocation(meta: PlanMeta, location: string): boolean {
  return locationNames(meta).includes(location);
}

function plansForLocation(plans: PlanMeta[], location: string): PlanMeta[] {
  return plans.filter((meta) => hasLocation(meta, location));
}

function destinationRows(plans: PlanMeta[]): DestinationRow[] {
  const rows = new Map<string, DestinationRow>();
  plans.forEach((meta) => {
    locationEntries(meta).forEach((entry) => {
      const row = rows.get(entry.name) || { name: entry.name, count: 0 };
      row.count += 1;
      if (!row.coords && entry.coords) row.coords = entry.coords;
      rows.set(entry.name, row);
    });
  });
  return [...rows.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
}

function renderLocationCityList(plans: PlanMeta[]): void {
  const rows = destinationRows(plans);
  locationExplorerEl.classList.remove("is-plan-mode");
  locationSideEl.classList.remove("is-plan-mode");
  locationHeadEl.innerHTML =
    '<div class="location-head-main"><span class="location-head-ic">' + icon("globeAlt") + '</span>' +
    '<span class="location-head-copy"><span class="location-head-kicker">Destinations</span>' +
    '<p class="location-side-title">都市・国から選ぶ</p>' +
    '<span class="location-side-note">一覧または地図のピンから旅行計画を確認</span></span></div>';
  locationPlansEl.hidden = true;
  locationPlansEl.innerHTML = "";
  destinationsEl.hidden = false;
  destinationsEl.innerHTML = rows.length
    ? rows.map((row) =>
        '<a class="dest-row" href="#" data-no-transition="true" data-dest-filter="' + escapeHtml(row.name) + '"><b>' +
        escapeHtml(row.name) +
        "</b><span>" +
        row.count +
        "件の旅行計画</span></a>",
      ).join("")
    : emptyList("行き先別の一覧は、公開旅行が増えると表示されます。");
  destinationCountEl.textContent = rows.length ? rows.length + "地域" : "";
}

function renderLocationPlans(plans: PlanMeta[]): PlanMeta[] {
  const selected = state.selectedLocation;
  const rows = plansForLocation(plans, selected);
  if (!state.selectedPlanSlug || !rows.some((meta) => meta.slug === state.selectedPlanSlug)) {
    state.selectedPlanSlug = rows[0]?.slug || "";
  }
  locationExplorerEl.classList.add("is-plan-mode");
  locationSideEl.classList.add("is-plan-mode");
  locationHeadEl.innerHTML =
    '<div class="location-head-main"><span class="location-head-ic">' + icon("mapPin") + '</span>' +
    '<span class="location-head-copy"><span class="location-head-kicker">Selected Area</span>' +
    '<p class="location-side-title">' + escapeHtml(selected) + '</p>' +
    '<span class="location-side-note">この都市の旅行計画 ' + rows.length + '件</span></span></div>' +
    '<button class="location-back" type="button" data-location-back>' + icon("arrowLeft") + '<span>一覧へ戻る</span></button>';
  destinationsEl.hidden = true;
  // 計画が1件だけのときは、この一覧は下の詳細と同じことを繰り返すだけなので出さない
  // （件数は見出しの「この都市の旅行計画 ◯件」で分かる）。
  // 複数あるときは切り替えの役目があるので残す。
  // 0件のときは案内を出したいので、隠すのは「ちょうど1件」のときだけ。
  locationPlansEl.hidden = rows.length === 1;
  // 複数あるときは横に流れるタブで切り替える（カードにすると下の詳細と
  // 同じ内容が二重に並ぶため）。選んでいるものは下線で示す。
  locationPlansEl.innerHTML = rows.length > 1
    ? '<div class="location-plan-tabs" role="tablist">' +
      rows.map((meta) =>
        '<a class="location-plan-tab' + (meta.slug === state.selectedPlanSlug ? " is-active" : "") +
        '" href="#" role="tab" aria-selected="' + (meta.slug === state.selectedPlanSlug ? "true" : "false") +
        '" data-no-transition="true" data-location-plan="' + escapeHtml(meta.slug) + '">' +
        '<b>' + escapeHtml(meta.title || "無題の旅行") + '</b>' +
        '<small>' + escapeHtml(meta.dates || "") + '</small></a>',
      ).join("") +
      "</div>"
    : rows.length ? "" : emptyList("この場所の旅行計画はまだありません。");
  return rows;
}

function itineraryFor(meta: PlanMeta | undefined): LocalPlanData | null {
  if (!meta) return null;
  return TripPlans.getData(meta.slug);
}

function itemTitle(item: LocalPlanData["itinerary"][number]): string {
  return item.title || item.place || item.area || item.destination || item.origin || "予定";
}

const SCHEDULE_KIND_ICON: Record<string, IconName> = {
  sight: "camera",
  food: "cake",
  move: "arrowsRightLeft",
  stay: "buildingOffice2",
  todo: "check",
  form: "documentText",
};

function scheduleKindClass(type: string | undefined): string {
  const normalized = String(type || "todo");
  return SCHEDULE_KIND_ICON[normalized] ? normalized : "todo";
}

function scheduleKindIcon(type: string | undefined): string {
  return icon(SCHEDULE_KIND_ICON[String(type || "")] || "check");
}

function scheduleMapLink(query: string | undefined): string {
  return '<a class="schedule-maplink" href="' + mapsSearchUrl(query) + '" target="_blank" rel="noopener">地図 ' +
    icon("arrowTopRightOnSquare") + '</a>';
}

function scheduleMetaText(item: LocalPlanData["itinerary"][number]): string {
  const title = itemTitle(item);
  const place = item.place && item.place !== title ? "場所: " + item.place : "";
  const move = String(item.type) === "move" ? [item.transport, item.duration].filter(Boolean).join("・") : "";
  return [move || place, item.note].filter(Boolean).join(" / ");
}

function scheduleDayHead(rows: LocalPlanData["itinerary"], index: number): string {
  const first = rows[0];
  const day = first?.day || "Day " + (index + 1);
  const area = first?.area || "";
  const date = mdLabel(first?.date);
  const title = [day, area, date].filter(Boolean).join(" ・ ");
  const weather = rows.find((row) => row.weather)?.weather || "";
  return '<div class="schedule-dayblock-head"><b>' + escapeHtml(title || "日程") + '</b>' +
    (weather ? '<span class="schedule-weather">' + escapeHtml(weather) + '</span>' : "") + '</div>';
}

function scheduleStayHtml(item: LocalPlanData["itinerary"][number]): string {
  const title = itemTitle(item) || "宿泊先";
  const place = item.place && item.place !== title ? item.place : "";
  return '<div class="schedule-stay">' +
    '<span class="schedule-stay-ic">' + icon("buildingOffice2") + '</span>' +
    '<div class="schedule-stay-body">' +
    '<span class="schedule-stay-label">' + escapeHtml(item.typeLabel || "宿泊") + '</span>' +
    '<span class="schedule-stay-name">' + escapeHtml(title) + '</span>' +
    (place ? '<span class="schedule-stay-place">' + escapeHtml(place) + '</span>' : "") +
    '</div>' +
    scheduleMapLink(item.mapQuery || item.place || title) +
    '</div>';
}

function scheduleItemHtml(item: LocalPlanData["itinerary"][number]): string {
  const type = String(item.type || "todo");
  const kind = scheduleKindClass(type);
  const label = '<span class="schedule-kind ' + kind + '">' +
    escapeHtml(item.typeLabel || type || "予定") + '</span>';
  let segA = item.origin || "";
  let segB = item.destination || "";
  if (kind === "move" && (!segA || !segB) && /→|->/.test(item.title || "")) {
    const parts = (item.title || "").split(/→|->/);
    segA = segA || (parts[0] || "").trim();
    segB = segB || (parts[1] || "").trim();
  }
  const title = kind === "move" && (segA || segB)
    ? '<div class="schedule-seg"><span>' + escapeHtml(segA || "出発") + '</span>' +
      '<span class="schedule-seg-arr">' + icon("arrowLongRight") + '</span>' +
      '<span>' + escapeHtml(segB || "到着") + '</span></div>'
    : '<h3>' + escapeHtml(itemTitle(item)) + '</h3>';
  const meta = scheduleMetaText(item);
  return '<article class="schedule-tl-item" data-kind="' + kind + '">' +
    '<time class="schedule-time">' + escapeHtml(item.time || "") + '</time>' +
    '<span class="schedule-rail"><span class="schedule-dot ' + kind + '">' + scheduleKindIcon(type) + '</span></span>' +
    '<div class="schedule-plan">' +
    '<div class="schedule-plan-line">' + label + title + '</div>' +
    (item.needed ? '<p class="schedule-needed">' + escapeHtml(item.needed) + '</p>' : "") +
    '<p class="schedule-meta">' +
    (meta ? '<span class="schedule-meta-text">' + escapeHtml(meta) + '</span>' : "") +
    scheduleMapLink(item.mapQuery || item.place || item.title) +
    '</p>' +
    '</div>' +
    '</article>';
}

function renderSchedule(plan: PlanMeta | undefined): void {
  mapBoardEl.hidden = true;
  locationScheduleEl.hidden = false;
  if (!plan) {
    locationScheduleEl.innerHTML = emptyList("旅行計画を選択してください。");
    return;
  }
  const data = itineraryFor(plan);
  const items = data?.itinerary || [];
  const head =
    '<div class="schedule-head"><span class="schedule-head-ic">' + icon("calendarDays") + '</span>' +
    '<div class="schedule-head-main"><span class="schedule-head-kicker">Itinerary</span>' +
    '<b>' + escapeHtml(plan.title || "無題の旅行") + '</b>' +
    '<span class="schedule-head-meta">' + escapeHtml([plan.dates, locationLabel(plan)].filter(Boolean).join(" ・ ") || "日程情報") + '</span></div>' +
    '<a href="' + planHref(plan, !canEditPlan(plan)) + '">旅行計画を開く ' + icon("arrowTopRightOnSquare") + '</a></div>';
  if (!items.length) {
    locationScheduleEl.innerHTML = head + emptyList("この計画の日程データはまだありません。");
    return;
  }
  const groups = new Map<string, typeof items>();
  items.forEach((item) => {
    const key = [item.date, item.day].filter(Boolean).join(" ") || "日程未設定";
    const arr = groups.get(key) || [];
    arr.push(item);
    groups.set(key, arr);
  });
  locationScheduleEl.innerHTML = head + '<div class="schedule-list">' +
    [...groups.values()].map((rows, index) =>
      '<section class="schedule-dayblock">' +
      scheduleDayHead(rows, index) +
      rows.filter((item) => String(item.type) === "stay").map(scheduleStayHtml).join("") +
      '<div class="schedule-timeline">' +
      rows.filter((item) => String(item.type) !== "stay").map(scheduleItemHtml).join("") +
      '</div>' +
      '</section>',
    ).join("") +
    '</div>';
}

function renderLocationMap(plans: PlanMeta[]): void {
  const rows = destinationRows(plans);
  const totalPlans = plans.length;
  mapCountEl.textContent = totalPlans ? totalPlans + "件" : "";
  locationScheduleEl.hidden = true;
  locationScheduleEl.innerHTML = "";
  mapBoardEl.hidden = false;
  if (!rows.length) {
    if (locationMapState.map) {
      locationMapState.map.remove();
      locationMapState.map = null;
      locationMapState.layer = null;
    }
    mapBoardEl.innerHTML = '<div class="map-empty">公開旅行が増えると、ここに行き先のピンが並びます。</div>';
    return;
  }
  const destinations = new Map<string, { name: string; coords: L.LatLngTuple; count: number }>();
  rows.forEach((row) => {
    const fallback = TripPlans.coordsFor(row.name);
    const coords = row.coords || (fallback ? [fallback.lat, fallback.lng] as L.LatLngTuple : undefined);
    if (!coords) return;
    const key = row.name + ":" + coords[0].toFixed(3) + "," + coords[1].toFixed(3);
    destinations.set(key, { name: row.name, coords, count: row.count });
  });
  const points = [...destinations.values()];
  if (!points.length) {
    if (locationMapState.map) {
      locationMapState.map.remove();
      locationMapState.map = null;
      locationMapState.layer = null;
    }
    mapBoardEl.innerHTML = '<div class="map-empty">座標が分かる都市名があると、ここに地図ピンが表示されます。</div>';
    return;
  }

  mapBoardEl.classList.add("has-leaflet");
  if (!locationMapState.map) {
    mapBoardEl.innerHTML = "";
    locationMapState.map = L.map(mapBoardEl, {
      scrollWheelZoom: false,
      attributionControl: true,
      zoomControl: true,
    });
    addBaseLayer(L, locationMapState.map);
  }
  const map = locationMapState.map;
  if (locationMapState.layer) locationMapState.layer.remove();
  locationMapState.layer = L.layerGroup().addTo(map);
  const bounds = L.latLngBounds([]);
  points.forEach((point) => {
    const shortName = point.name.replace(/\s+/g, "").slice(0, 4);
    const marker = L.marker(point.coords, {
      icon: L.divIcon({
        className: "location-marker",
        html: `<span>${escapeHtml(shortName)}${point.count > 1 ? `<b>${point.count}</b>` : ""}</span>`,
        iconSize: [72, 34],
        iconAnchor: [36, 17],
      }),
    }).addTo(locationMapState.layer!);
    marker.bindTooltip(`${escapeHtml(point.name)} (${point.count}件)`, { direction: "top" });
    marker.on("click", () => {
      queueLocationTransition("forward");
      state.selectedLocation = point.name;
      state.selectedPlanSlug = "";
      renderDiscover(plans);
    });
    bounds.extend(point.coords);
  });
  window.setTimeout(() => {
    map.invalidateSize();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [42, 42], maxZoom: points.length === 1 ? 6 : 12 });
  }, 0);
}

function queueLocationTransition(direction: LocationTransition): void {
  pendingLocationTransition = direction;
}

function playLocationTransition(): void {
  const direction = pendingLocationTransition;
  pendingLocationTransition = "";
  if (!direction) return;
  window.clearTimeout(locationTransitionTimer);
  locationExplorerEl.classList.remove(
    "is-location-animating",
    "is-location-forward",
    "is-location-back",
    "is-location-swap",
  );
  void locationExplorerEl.offsetWidth;
  locationExplorerEl.classList.add("is-location-animating", "is-location-" + direction);
  locationTransitionTimer = window.setTimeout(() => {
    locationExplorerEl.classList.remove(
      "is-location-animating",
      "is-location-forward",
      "is-location-back",
      "is-location-swap",
    );
  }, 340);
}

function renderLocationExplorer(plans: PlanMeta[]): void {
  if (!state.selectedLocation || !plansForLocation(plans, state.selectedLocation).length) {
    state.selectedLocation = "";
    state.selectedPlanSlug = "";
    renderLocationCityList(plans);
    renderLocationMap(plans);
    playLocationTransition();
    return;
  }
  const rows = renderLocationPlans(plans);
  const selected = rows.find((meta) => meta.slug === state.selectedPlanSlug) || rows[0];
  renderSchedule(selected);
  playLocationTransition();
}

function renderStart(): void {
  const invites = db.pendingInvites();
  createMainEl.innerHTML = icon("plusCircle") + "<span>新しい旅行計画を作る</span>";
  createMainEl.href = newPlanHref();
  inviteStripEl.classList.toggle("is-visible", invites.length > 0);
  if (invites.length) {
    inviteTitleEl.textContent = "未参加の招待があります";
    inviteNoteEl.textContent = invites.map((invite) => invite.plan_title).slice(0, 3).join("、");
  }
}

function newPlanHref(): string {
  if (!db.isEnabled() || isIdentified()) return "plan-editor.html";
  return "login.html?returnTo=" + encodeURIComponent("plan-editor.html");
}

function renderDiscover(publicPlans: PlanMeta[]): void {
  renderRankings(publicPlans);
  renderLocationExplorer(publicPlans);
}

type RowVariant = "mine" | "public";

/** 1枚のカード（計画）の HTML を組み立てる。variant で「自分の計画」/「みんなの公開計画」を出し分ける。 */
function rowHtml(
  meta: PlanMeta,
  variant: RowVariant,
  activeSlug: string,
  highlight?: PlanTiming,
  badge?: string,
): string {
  const src = sourceClass(meta.source);
  const isLocal = meta.source === "local";
  const isActive = meta.slug === activeSlug;
  const metaLine = (variant === "public" ? [meta.dates] : [meta.dates, meta.members]).filter(Boolean).map(escapeHtml).join(" · ");
  const compactLocations = compactLocationLabel(meta);
  const authorLine =
    variant === "public"
      ? creatorLinkHtml(meta, "plan-author")
      : "";
  const openHref = planHref(meta, variant === "public" || !canEditPlan(meta));
  const role = roleOf(meta);
  const roleBadge = role
    ? '<span class="role-badge ' + role + '">' + escapeHtml(roleLabel(role)) + "</span>"
    : "";
  const highlightBadge =
    highlight === "current"
      ? '<span class="plan-highlight-badge current">期間中</span>'
      : highlight === "upcoming"
        ? '<span class="plan-highlight-badge upcoming">直近</span>'
        : "";

  const menuItems =
    variant === "public"
      ? '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>自分の計画に複製</span></button>"
      : ((role === "owner" || role === "editor") && isLocal
          ? '<button class="plan-menu-item" type="button" data-edit>' + icon("pencilSquare") + "<span>編集</span></button>"
          : "") +
        '<button class="plan-menu-item" type="button" data-dup>' +
        icon("documentDuplicate") +
        "<span>複製</span></button>" +
        (meta.builtIn || role !== "owner"
          ? ""
          : '<button class="plan-menu-item danger" type="button" data-del>' + icon("trash") + "<span>削除</span></button>");

  const nameExtra =
    variant === "public"
      ? '<span class="plan-tag">公開</span>'
      : isActive
        ? '<span class="plan-tag">表示中</span>'
        : "";

  const coverSrc = planCoverThumbnail(meta);
  const sourceLabelText = SOURCE_LABEL[src] || src;
  const views = getViews(meta.slug);
  const viewsBadge =
    '<div class="plan-views-badge" title="観覧数" aria-label="観覧数 ' +
    views +
    '">' +
    icon("eye") +
    "<span>" +
    views.toLocaleString("ja-JP") +
    "</span></div>";

  return (
    '<article class="plan-row' +
    (variant === "mine" && isActive ? " is-active" : "") +
    (highlight ? " is-" + highlight : "") +
    '" data-slug="' +
    escapeHtml(meta.slug) +
    '" data-variant="' +
    variant +
    '">' +
    (badge
      ? '<div class="plan-dot-badge is-rank"><span>' + escapeHtml(badge) + "</span></div>"
      : '<div class="plan-dot-badge">' +
    '<span class="plan-dot ' +
    src +
    '" title="' +
    escapeHtml(sourceLabelText) +
    '" aria-label="' +
    escapeHtml(sourceLabelText) +
    '"></span>' +
    "<span>" +
    escapeHtml(sourceLabelText) +
    "</span>" +
    "</div>") +
    '<a class="plan-open" href="' +
    openHref +
    '" data-open>' +
    '<div class="plan-cover">' +
    '<img src="' +
    escapeHtml(coverSrc) +
    '" alt="' +
    escapeHtml(meta.title || "旅行画像") +
    '" loading="lazy">' +
    viewsBadge +
    "</div>" +
    '<span class="plan-body">' +
    '<span class="plan-name">' +
    '<span class="plan-name-text">' +
    escapeHtml(meta.title || "無題の旅行") +
    nameExtra +
    "</span>" +
    roleBadge +
    highlightBadge +
    "</span>" +
    authorLine +
    (metaLine ? '<span class="plan-meta">' + metaLine + "</span>" : "") +
    (compactLocations ? '<span class="plan-route">' + escapeHtml(compactLocations) + "</span>" : "") +
    "</span>" +
    "</a>" +
    '<div class="plan-tools">' +
    '<button class="plan-menu-btn" type="button" data-menu aria-haspopup="true" aria-expanded="false" aria-label="操作メニュー">' +
    icon("ellipsisHorizontal") +
    "</button>" +
    '<div class="plan-menu" data-menu-panel hidden>' +
    menuItems +
    "</div>" +
    "</div>" +
    "</article>"
  );
}

function matchesFilter(meta: PlanMeta, filter: string): boolean {
  return !filter || planText(meta).indexOf(filter) >= 0;
}

function render(): void {
  TripPlans.ensureSeed(readGlobalTripConfig());
  planDataCache.clear();
  const activeSlug = TripPlans.getActiveSlug();
  const filter = state.filter.trim().toLowerCase();
  // 「自分の計画」は本人が確定していれば出す。
  // 旧構造はアカウントのログイン有無で出し分けていたが、いまは identity（user_id）が正。
  const loggedIn = isIdentified();

  const all = TripPlans.list();
  const mine = loggedIn ? sortMinePlans(TripPlans.listMine().filter((m) => matchesFilter(m, filter))) : [];
  const others = TripPlans.listPublic().filter((m) => matchesFilter(m, filter));
  const discoverPlans = all.filter((m) => TripPlans.isPublished(m) && TripPlans.planVisibility(m) === "public" && m.source !== "sample");
  const mineHighlights = highlightedMineSlugs(mine);

  const mineTotal = TripPlans.listMine().length;
  if (loggedIn) {
    inviteStripEl.after(toolbarEl);
    toolbarEl.after(mineHeadEl);
    mineHeadEl.after(gridMine);
    gridMine.after(discoverSectionEl);
  } else {
    inviteStripEl.after(discoverSectionEl);
    discoverSectionEl.after(toolbarEl);
    toolbarEl.after(mineHeadEl);
    mineHeadEl.after(gridMine);
  }
  mineHeadEl.hidden = !loggedIn;
  gridMine.hidden = !loggedIn;

  if (countEl) countEl.textContent = mineTotal ? "自分の計画 " + mineTotal + "件" : "計画はまだありません";
  countMineEl.textContent = mine.length ? mine.length + "件" : "";
  renderStart();
  renderDiscover(discoverPlans);

  // --- 自分の計画 ---
  if (!loggedIn) {
    gridMine.innerHTML = "";
    countMineEl.textContent = "";
  } else if (mine.length) {
    gridMine.innerHTML = mine.map((meta) => rowHtml(meta, "mine", activeSlug, mineHighlights.get(meta.slug))).join("");
  } else {
    gridMine.innerHTML =
      '<div class="hub-empty">' +
      (mineTotal
        ? '<div class="hub-empty-simple"><b>該当する計画がありません</b><span>検索条件を変えてください</span></div>'
        : '<div class="hub-empty-layout">' +
          '<span class="hub-empty-tag">' + icon("sparkles") + '<span>FIRST TRIP</span></span>' +
          '<div class="hub-empty-art" aria-hidden="true">' +
          '<img src="' + emptyTripCover + '" alt="">' +
          '<span class="hub-empty-pin start">' + icon("mapPin") + '</span>' +
          '<span class="hub-empty-pin end">' + icon("flag") + '</span>' +
          '<span class="hub-empty-route"></span>' +
          '</div>' +
          '<div class="hub-empty-copy">' +
          '<b>最初の計画を作りましょう</b>' +
          '<span>行き先、日程、メンバーを入れて旅の下書きを始められます</span>' +
          '</div>' +
          '<div class="hub-empty-steps">' +
          '<span>' + icon("mapPin") + '<i>01</i>行き先</span>' +
          '<span>' + icon("calendarDays") + '<i>02</i>日程</span>' +
          '<span>' + icon("listBullet") + '<i>03</i>行程</span>' +
          '</div>' +
          '<a class="hub-empty-cta" href="' + newPlanHref() + '">' + icon("plusCircle") + '<span>新規計画を作る</span></a>' +
          '</div>') +
      "</div>";
  }

  // --- みんなの公開計画（0件のときはセクションごと隠す） ---
  if (others.length) {
    gridPublic.innerHTML = others.map((meta) => rowHtml(meta, "public", activeSlug)).join("");
    countPublicEl.textContent = others.length + "件";
    publicHead.hidden = false;
    gridPublic.hidden = false;
  } else {
    gridPublic.innerHTML = "";
    countPublicEl.textContent = "";
    publicHead.hidden = true;
    gridPublic.hidden = true;
  }
}

function closeMenus(except?: Element | null): void {
  hub.querySelectorAll<HTMLElement>("[data-menu-panel]").forEach((panel) => {
    if (panel === except) return;
    panel.hidden = true;
    const btn = panel.parentElement?.querySelector<HTMLButtonElement>("[data-menu]");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

/**
 * 計画を自分のローカル計画へ複製する。
 * 公開計画からの複製時は、所有＝メンバーのため自分の名前をメンバーに加え、
 * 「自分の計画」セクションに出るようにする。
 */
async function duplicateToMine(slug: string, fromPublic: boolean): Promise<void> {
  if (!currentUserId()) {
    navigateWithPageTransition("login.html?returnTo=" + encodeURIComponent("plans.html"));
    return;
  }
  // 既にコピーを持っているなら、作り直さずそれを開く。
  const already = TripPlans.existingCopyOf(slug);
  if (already) {
    showToast("すでにコピーがあります。そのコピーを開きます");
    navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(already.slug));
    return;
  }
  let copy: PlanMeta | null = null;
  try {
    copy = await TripPlans.duplicateAndSave(slug);
  } catch (error) {
    render();
    showToast("コピーを保存できませんでした");
    console.error("[plans] duplicate", error);
    return;
  }
  if (!copy) {
    render();
    return;
  }
  // 参加者は duplicate() が複製者ひとりに揃えるので、ここでは触らない。
  render();
  showToast(fromPublic ? "自分の計画に複製しました。編集画面を開きます" : "計画を複製しました。編集画面を開きます");
  navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(copy.slug));
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".plan-tools")) return;
  closeMenus();
});

function openAuthorPage(link: HTMLElement): void {
  const href = link.dataset.authorLink;
  if (!href) return;
  navigateWithPageTransition(href);
}

hub.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const authorLink = target.closest<HTMLElement>("[data-author-link]");
  if (authorLink) {
    event.preventDefault();
    event.stopPropagation();
    openAuthorPage(authorLink);
    return;
  }
  const card = target.closest<HTMLElement>("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug || "";
  const variant = (card.dataset.variant as RowVariant) || "mine";

  const menuButton = target.closest<HTMLButtonElement>("[data-menu]");
  if (menuButton) {
    event.preventDefault();
    const panel = card.querySelector<HTMLElement>("[data-menu-panel]");
    if (!panel) return;
    const willOpen = panel.hidden;
    closeMenus(willOpen ? panel : null);
    panel.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  if (target.closest("[data-open]")) {
    TripPlans.setActiveSlug(slug);
    return; // リンク遷移はそのまま
  }
  closeMenus();
  if (target.closest("[data-edit]")) {
    event.preventDefault();
    TripPlans.setActiveSlug(slug);
    navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(slug));
    return;
  }
  if (target.closest("[data-dup]")) {
    event.preventDefault();
    void duplicateToMine(slug, variant === "public");
    return;
  }
  if (target.closest("[data-del]")) {
    event.preventDefault();
    const meta = TripPlans.get(slug);
    const name = meta && meta.title ? meta.title : "この計画";
    if (window.confirm("「" + name + "」を削除しますか？この操作は元に戻せません。")) {
      void TripPlans.remove(slug).then(
        () => render(),
        (error) => showToast("削除できませんでした: " + errorMessage(error), true),
      );
    }
    return;
  }
});

hub.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const authorLink = target.closest<HTMLElement>("[data-author-link]");
  if (!authorLink) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openAuthorPage(authorLink);
});

function showToast(message: string, isError?: boolean): void {
  const toast = document.createElement("div");
  toast.className = "pub-toast" + (isError ? " is-error" : "");
  const glyph = isError ? icon("exclamationTriangle") : icon("checkCircle");
  const text = document.createElement("span");
  text.textContent = message;
  toast.innerHTML = glyph;
  toast.appendChild(text);
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 6000);
}

filterEl.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | null;
  state.filter = (target && target.value) || "";
  hub.classList.toggle("has-search-filter", Boolean(state.filter.trim()));
  render();
});

destinationsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-dest-filter]");
  if (!link) return;
  event.preventDefault();
  const value = link.dataset.destFilter || "";
  queueLocationTransition("forward");
  state.selectedLocation = value;
  state.selectedPlanSlug = "";
  render();
});

locationHeadEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest("[data-location-back]")) return;
  event.preventDefault();
  queueLocationTransition("back");
  state.selectedLocation = "";
  state.selectedPlanSlug = "";
  render();
});

locationPlansEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-location-plan]");
  if (!link) return;
  event.preventDefault();
  queueLocationTransition("swap");
  state.selectedPlanSlug = link.dataset.locationPlan || "";
  render();
});

window.addEventListener("trip-backend-sync", () => {
  render();
});

window.addEventListener("trip-account-logout", () => {
  state.filter = "";
  state.selectedLocation = "";
  state.selectedPlanSlug = "";
  filterEl.value = "";
  hub.classList.remove("is-search-open", "has-search-filter");
  searchToggleEl.setAttribute("aria-expanded", "false");
  render();
});

window.addEventListener("resize", () => {
  window.clearTimeout(rankingResizeTimer);
  rankingResizeTimer = window.setTimeout(() => {
    if (rankingCardLimit() !== lastRankingLimit) render();
  }, 120);
});

registerServiceWorker();

// 招待リンク（plans.html#join=<token>）を開いたら、計画を取り込んでダッシュボードへ。
// 同じ計画（slug 一致）が既にあれば重複作成せず、本文を最新に更新しつつ候補の票はマージする。
async function handleJoinLink(): Promise<boolean> {
  const m = /(?:^|[#&])join=([^&]+)/.exec(location.hash || "");
  if (!m) return false;
  history.replaceState(null, "", location.pathname + location.search);
  const payload = await decodeInvite(m[1]);
  if (!payload) {
    showToast("招待リンクを読み込めませんでした。", true);
    return false;
  }
  const slug = TripPlans.safeSlug(payload.meta.slug || payload.meta.title || "trip");
  if (payload.token) {
    if (!isIdentified()) {
      const returnTo = `${location.pathname}${location.search}#join=${encodeURIComponent(m[1])}`;
      navigateWithPageTransition("login.html?returnTo=" + encodeURIComponent(returnTo), { replace: true });
      return true;
    }
    try {
      const accepted = await db.acceptInvite(payload.token);
      const nextSlug = accepted.planSlug || slug;
      TripPlans.setActiveSlug(nextSlug);
      navigateWithPageTransition(planDashboardHref(nextSlug), { replace: true });
    } catch (error) {
      showToast(errorMessage(error) || "招待リンクを受け取れませんでした。ログインしてからもう一度開いてください。", true);
    }
    return true;
  }
  showToast("この招待リンクは旧形式です。計画の所有者に新しいリンクの発行を依頼してください。", true);
  return true;
}

// 共有ストア（MySQL）を読み終えてから描画する。
// 読む前に描くと計画0件に見え、書き込むと実在しない行を作ってしまう。
void db.load().then(() => handleJoinLink()).then((joined) => {
  if (!joined) render();
});

// 控え（キャッシュ）で先に描いているので、裏の取り直しで中身が変わったら描き直す。
db.onDbSync(render);
