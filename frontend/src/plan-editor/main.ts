// 旅行計画エディタ（フル刷新版）。
// 設計方針:
//  - 2段階: まず骨組み（旅行名・期間・メンバー・ルート都市）→ 各日を後から肉付け。
//  - 種別ごとに表示を最適化: 移動=区間 / 宿泊=その日の錨 / 観光・食事=タイムライン。
//  - 折りたたみ行（タップで編集）＋ クイック追加 ＋ 編集内ライブ地図（ピン+ルート）。
//  - 保存時は従来の LocalPlanData.itinerary（ItineraryItem[]）へフラット化し、ダッシュボード互換。

import L from "leaflet";
import * as db from "../shared/db";
import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";
import flatpickr from "flatpickr";
import { Japanese } from "flatpickr/dist/l10n/ja.js";
import "flatpickr/dist/flatpickr.css";
import Sortable from "sortablejs";

import * as TripPlans from "../shared/plans-store";
import type { PlanVisibility } from "../shared/plans-store";
import type { ItineraryItem, Candidate } from "../shared/types";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml, errorMessage } from "../shared/dom";
import { parseISO, toISO, weekday, mdOf, mdLabel } from "../shared/date";
import { icon, type IconName } from "../shared/icons";
import { planCoverThumbnail } from "../shared/cover";
import { registerServiceWorker } from "../shared/pwa";
import { getUser } from "../shared/user-store";
import { splitNames } from "../shared/friend-store";
import { buildInviteLink } from "../shared/invite";
import { gcalUrl, buildIcs, type CalEvent } from "../shared/calendar";
import { currentAccount } from "../shared/account-store";
import { listFriends } from "../shared/friendship-store";
import { canEditPlan, canEditPlanMetadata, canManagePlan, planHasOwner } from "../shared/membership";
import { presentMemberIds } from "../shared/member-period";
import { dayTracks, pickTrack, isItemInTrack, everyoneIds, type DayTrack } from "../shared/day-tracks";
import { validatePublishPlan } from "./validation";
import { formatDurationMinutes } from "../shared/travel-duration";
import { AiConsultationState, type AiStage } from "./ai-consultation-state";
import { aiErrorGuidance, retryWaitLabel, type AiErrorPhase } from "./ai-error-guidance";
import { resolveAiMapGeocodeJobs, type AiMapGeocodeSummary } from "./ai-map-geocoding";
import { buildExternalAiCreatePrompt, copyExternalAiPrompt, openExternalAi, parseExternalAiCreateJson } from "../shared/external-ai";
import {
  automaticGeocodingAvailable,
  cityAliasesFor,
  geocodingAttribution,
  reverseCityName,
  reverseLocation,
  searchLocations,
  type GeoContext,
  type GeoResult,
} from "../shared/geocoding";
import {
  type ItemKind, type ItemStrKey, type Item, type Day, type City, type GeoTarget,
  KINDS, TRANSPORTS, TRANSPORT_ICONS,
  params, isNew, state, model, newItem, datesString, timeOrder, normalizeToISO,
  cityDateDefault, applyCityDateDefaults, num, hasLatLng, autoCoords, clearItemCoords, latLngKeys,
  findItem, inclusiveDateCount, worthSaving, normalizeKind,
  stayCovering, cityForDate,
} from "./editor-state";
import {
  root, qs, daysEl, statusEl, titleEcho, mapHeaderBtn, warnEl, dayCountEl, savebarNoteEl,
  citiesEl, cityInput, cityOptions, mapEl, mapHintEl, rangeEl, rangeTrigger, rangeLabel, dayStripEl, tripSummaryEl,
  aiArea, aiNote, aiRun, aiRunLabel, aiRunIcon, aiBar, aiStatus, aiError, aiErrorTitle, aiErrorMessage,
  aiErrorAction, aiErrorReference, aiIntro, aiDialog, aiThread, aiCandidatesStage, aiPreferencesStage, aiDoneStage,
  aiCandidateList, aiSelection, aiToPreferences, aiBuild, aiWalking, aiTransport, aiExtra, aiImportDetails,
  aiImportOpen, aiImportJson, aiImportApply, aiImportStatus,
  coverInput, coverClearBtn, coverPreview,
  membersMount, memberField, memberSelect, memberAddBtn, memberNameInput, memberNameAddBtn, memberHint, activeInvitesMount,
  candMount, candInput, candCountEl, gcalBtn, icsBtn,
  saveBtn, publishBtn, stepNextBtn, localNoteEl, exportBtn, mapToggle, mapClose,
  toast, watchComposition, isComposingKey,
} from "./editor-dom";
import { setMapHandlers, ensureMap, showCandidates, clearCandidates, refreshMap, scheduleMapRefresh, setMapCollapsed, bindMapResizeGrip } from "./map";
import { stepCompletion, updateSteps, setViewStep } from "./steps";
import { buildData, contentFingerprint } from "./plan-data";
import { setPersistHooks, setLastSavedContentFingerprint, markDirty, persist } from "./persist";

initPageTransitions();


function countryFromText(text: string | undefined): CountryCode | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  return COUNTRY_TEXT_HINTS.find(([pattern]) => pattern.test(raw))?.[1] || null;
}

function countryFromCoords(latValue: string, lngValue: string): CountryCode | null {
  if (!hasLatLng(latValue, lngValue)) return null;
  const lat = num(latValue);
  const lng = num(lngValue);
  const inBox = (minLat: number, maxLat: number, minLng: number, maxLng: number): boolean =>
    lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  if (inBox(24, 46, 122, 154)) return "JP";
  if (inBox(5, 21, 97, 106)) return "TH";
  if (inBox(24, 50, -125, -66) || inBox(18, 23, -161, -154)) return "US";
  if (inBox(41, 52, -5.5, 10)) return "FR";
  if (inBox(49, 61, -8.5, 2.5)) return "GB";
  if (inBox(33, 39, 124, 132)) return "KR";
  // 台湾本島に加えて金門・馬祖（東経118度台）も台湾の検索文脈に含める。
  if (inBox(21, 27, 118, 123)) return "TW";
  if (inBox(22.1, 22.6, 113.8, 114.4)) return "HK";
  if (inBox(18, 54, 73, 135)) return "CN";
  if (inBox(1.1, 1.6, 103.5, 104.1)) return "SG";
  if (inBox(8, 24, 102, 110)) return "VN";
  if (inBox(0, 8, 99, 120)) return "MY";
  if (inBox(-11, 6, 95, 142)) return "ID";
  if (inBox(4, 22, 116, 127)) return "PH";
  if (inBox(6, 36, 68, 98)) return "IN";
  if (inBox(41, 53, 87, 120)) return "MN";
  if (inBox(47, 55, 5, 16)) return "DE";
  if (inBox(35, 44, -10, 5)) return "ES";
  if (inBox(36, 47, 6, 19)) return "IT";
  if (inBox(-44, -10, 112, 154)) return "AU";
  return null;
}

function countryForCity(city: City | null): CountryCode | null {
  if (!city) return null;
  return countryFromText(city.name) || countryFromCoords(city.lat, city.lng);
}

function nextDifferentCityCountry(dayIndex: number, current: CountryCode | null): CountryCode | null {
  if (!current) return null;
  for (let i = dayIndex + 1; i < model.days.length; i++) {
    const nextCountry = countryForCity(cityForDate(model.days[i].date));
    if (nextCountry && nextCountry !== current) return nextCountry;
    if (nextCountry === current) return null;
  }
  return null;
}

function moveEndpointCountry(item: Item, target: "from" | "to", label = ""): CountryCode | null {
  if (target === "from") {
    return countryFromText(label) || countryFromText(item.from) || countryFromCoords(item.fromLat, item.fromLng);
  }
  return countryFromText(label) || countryFromText(item.to) || countryFromCoords(item.toLat, item.toLng);
}

function shouldDefaultMoveToAirplane(
  item: Item,
  day: Day,
  resultLabel = "",
  labelTarget?: "from" | "to",
  useDayTransition = false,
): boolean {
  if (item.kind !== "move" || item.transport.trim()) return false;
  const fromCountry = moveEndpointCountry(item, "from", labelTarget === "from" ? resultLabel : "");
  const toCountry = moveEndpointCountry(item, "to", labelTarget === "to" ? resultLabel : "");
  if (fromCountry && toCountry) return fromCountry !== toCountry;
  if (!useDayTransition) return false;
  const dayIndex = model.days.indexOf(day);
  const currentCountry = countryForCity(cityForDate(day.date));
  return Boolean(currentCountry && nextDifferentCityCountry(dayIndex, currentCountry));
}

function maybeDefaultMoveTransport(
  item: Item,
  day: Day,
  resultLabel = "",
  labelTarget?: "from" | "to",
  useDayTransition = false,
): void {
  if (shouldDefaultMoveToAirplane(item, day, resultLabel, labelTarget, useDayTransition)) item.transport = "飛行機";
}

function syncTransportSelect(item: Item): void {
  if (item.kind !== "move") return;
  const select = daysEl.querySelector<HTMLSelectElement>(`select[data-field="transport"][data-item="${item.id}"]`);
  if (select) select.value = item.transport;
}


type CountryCode =
  | "JP" | "TH" | "US" | "FR" | "GB" | "KR" | "TW" | "CN" | "HK" | "SG"
  | "VN" | "MY" | "ID" | "PH" | "IN" | "MN" | "DE" | "ES" | "IT" | "AU";

const COUNTRY_TEXT_HINTS: [RegExp, CountryCode][] = [
  [/日本|japan|東京|大阪|京都|長野|札幌|福岡|沖縄|那覇|羽田|成田|関空|新千歳|新宿|品川|横浜|名古屋|仙台|盛岡|青森|八戸/i, "JP"],
  [/タイ王国|タイ|thailand|bangkok|バンコク|suvarnabhumi|スワンナプーム/i, "TH"],
  [/アメリカ|米国|united states|usa|u\.s\.a|new york|ニューヨーク|manhattan|マンハッタン|los angeles|ロサンゼルス|san francisco|サンフランシスコ|hawaii|ハワイ|honolulu|ホノルル/i, "US"],
  [/フランス|france|paris|パリ/i, "FR"],
  [/イギリス|英国|united kingdom|uk|london|ロンドン/i, "GB"],
  [/韓国|south korea|korea|seoul|ソウル/i, "KR"],
  [/台湾|taiwan|taipei|台北|桃園|taoyuan|金門|kinmen|馬祖|matsu/i, "TW"],
  [/香港|hong kong/i, "HK"],
  [/中国|china|shanghai|上海|beijing|北京/i, "CN"],
  [/シンガポール|singapore/i, "SG"],
  [/ベトナム|vietnam|hanoi|ハノイ|ho chi minh|ホーチミン/i, "VN"],
  [/マレーシア|malaysia|kuala lumpur|クアラルンプール/i, "MY"],
  [/インドネシア|indonesia|bali|バリ|jakarta|ジャカルタ/i, "ID"],
  [/フィリピン|philippines|manila|マニラ/i, "PH"],
  [/インド|india|delhi|デリー/i, "IN"],
  [/モンゴル|mongolia|ulaanbaatar|ウランバートル/i, "MN"],
  [/ドイツ|germany|berlin|ベルリン/i, "DE"],
  [/スペイン|spain|madrid|マドリード|barcelona|バルセロナ/i, "ES"],
  [/イタリア|italy|rome|ローマ/i, "IT"],
  [/オーストラリア|australia|sydney|シドニー/i, "AU"],
];


// セクション見出しにアイコン
qs<HTMLElement>("[data-ic-route]").insertAdjacentHTML("afterbegin", icon("map") + " ");
qs<HTMLElement>("[data-ic-days]").insertAdjacentHTML("afterbegin", icon("calendarDays") + " ");
qs<HTMLElement>("[data-ic-cand]").insertAdjacentHTML("afterbegin", icon("star") + " ");
qs<HTMLElement>("[data-ic-ai]").insertAdjacentHTML("afterbegin", icon("sparkles") + " ");

// 入力ラベル・操作ボタンにも Heroicon を添える
const ICON_MOUNTS: [string, IconName][] = [
  ["[data-ic-name]", "bookmark"],
  ["[data-ic-period]", "calendarDays"],
  ["[data-ic-members]", "users"],
  ["[data-ic-memberadd]", "plus"],
  ["[data-ic-cal]", "calendarDays"],
  ["[data-ic-gcal]", "calendarDays"],
  ["[data-ic-ics]", "documentText"],
  ["[data-ic-note]", "documentText"],
  ["[data-ic-cover]", "photo"],
  ["[data-ic-coverpick]", "photo"],
  ["[data-city-add]", "plus"],
  ["[data-cand-add]", "plus"],
  ["[data-export]", "documentText"],
  ["[data-save]", "bookmark"],
];
ICON_MOUNTS.forEach(([selector, name]) => {
  const el = root.querySelector(selector);
  if (el) el.insertAdjacentHTML("afterbegin", icon(name) + " ");
});


function lockEditor(message: string): false {
  state.editorLocked = true;
  statusEl.textContent = message;
  statusEl.className = "is-dirty";
  savebarNoteEl.textContent = message;
  return false;
}

function applyEditorLock(): void {
  root.classList.add("is-readonly");
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    "input, select, textarea, button",
  ).forEach((control) => {
    control.disabled = true;
  });
}

/** 公開共同編集者には、サーバーが許可する行程・都市だけを編集させる。 */
function applyMetadataLock(): void {
  root.classList.add("is-metadata-readonly");
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    '[data-f="title"], [data-range-trigger], [data-f="note"], [data-member-field] input, ' +
    '[data-member-field] select, [data-member-field] button, [data-cover-input], [data-cover-clear]',
  ).forEach((control) => { control.disabled = true; });
  savebarNoteEl.textContent = "公開共同編集では、行程と訪問地だけを編集できます。旅行名・期間・画像は正式メンバーが変更できます。";
}

// 期間レンジピッカー（flatpickr・カレンダーで開始日→終了日を一括選択）
const fp = flatpickr(rangeEl, {
  mode: "range",
  dateFormat: "Y-m-d",
  locale: Japanese,
  clickOpens: false,
  disableMobile: true,
  onChange: (dates: Date[]) => {
    model.startDate = dates[0] ? toISO(dates[0]) : "";
    model.endDate = dates[1] ? toISO(dates[1]) : model.startDate;
    updateRangeButton();
    rebuildDays();
    renderDays();
    renderMembers(); // 参加期間の初期値・min/max・サマリ表示は旅行期間に依存する
    refreshMap(false);
    markDirty();
  },
  onOpen: () => {
    rangeTrigger.setAttribute("aria-expanded", "true");
  },
  onClose: () => {
    rangeTrigger.setAttribute("aria-expanded", "false");
  },
});

function updateRangeButton(): void {
  rangeLabel.textContent = datesString() || "期間を選択";
  rangeTrigger.classList.toggle("is-empty", !model.startDate);
}

rangeTrigger.addEventListener("click", () => {
  fp.open(undefined, rangeTrigger);
});



function rebuildDays(): void {
  const a = parseISO(model.startDate);
  const b = parseISO(model.endDate);
  warnEl.hidden = !(model.startDate && model.endDate && (!a || !b || b < a));
  if (!a || !b || b < a) return;
  const byDate: Record<string, Day> = {};
  model.days.forEach((d) => { byDate[d.date] = d; });
  const next: Day[] = [];
  const cursor = new Date(a.getTime());
  let guard = 0;
  while (cursor <= b && guard < 400) {
    const iso = toISO(cursor);
    next.push(byDate[iso] || { date: iso, area: "", items: [], stay: null });
    cursor.setDate(cursor.getDate() + 1);
    guard++;
  }
  model.days = next;
  applyCityDateDefaults();
}



const MAPBOX_TOKEN = readGlobalTripConfig().geocoding?.mapboxToken || "";

function geocodeSearch(query: string, context?: GeoContext, automatic = false): Promise<GeoResult[]> {
  return searchLocations(query, context, { mapboxToken: MAPBOX_TOKEN, automatic });
}


function geocodeContextForDay(day: Day, item?: Item, target?: GeoTarget): GeoContext | undefined {
  const city = cityForDate(day.date);
  const cityName = (city?.name || day.area || "").trim();
  const hasCityCoords = city ? hasLatLng(city.lat, city.lng) : false;
  const endpointText = target === "from" ? item?.from : target === "to" ? item?.to : item?.place;
  const endpointCountry = countryFromText(endpointText);
  const isMoveEndpoint = target === "from" || target === "to";
  // 国・都市を含む移動地点は旅行中の都市から独立して検索する。
  // 例: 金門島の日程にある「羽田空港」へ金門島の座標を付けない。
  if (isMoveEndpoint && endpointCountry) {
    return { countryCode: endpointCountry, purpose: "move" };
  }
  const countryCode = endpointCountry || countryForCity(city);
  if (!cityName && !hasCityCoords && !countryCode) return undefined;
  return {
    cityName,
    cityAliases: cityAliasesFor(cityName),
    lat: hasCityCoords ? num(city!.lat) : undefined,
    lng: hasCityCoords ? num(city!.lng) : undefined,
    countryCode: countryCode || undefined,
    purpose: isMoveEndpoint ? "move" : "place",
    requireNearby: item?.kind === "stay" && target === "place",
    radiusKm: item?.kind === "stay" ? 60 : 120,
  };
}


function stayNightLimits(item: Item): { cityMax: number; tripMax: number; cityName: string } {
  const found = findItem(item.id);
  if (!found) {
    const tripMax = Math.max(model.days.length, 1);
    item.nights = Math.max(1, Math.min(tripMax, Number(item.nights) || 1));
    return { cityMax: tripMax, tripMax, cityName: "" };
  }
  const dayIndex = model.days.indexOf(found.day);
  const city = cityForDate(found.day.date);
  const tripMax = Math.max(1, model.days.length - Math.max(0, dayIndex));
  const cityMax = city
    ? inclusiveDateCount(found.day.date, city.toDate)
    : tripMax;
  item.nights = Math.max(1, Math.min(tripMax, Number(item.nights) || 1));
  return { cityMax: Math.max(1, Math.min(cityMax, tripMax)), tripMax, cityName: city?.name || "" };
}

function stayNightOptions(item: Item): string {
  const limits = stayNightLimits(item);
  return Array.from({ length: limits.tripMax }, (_, i) => i + 1)
    .map((n) => {
      const note = limits.cityName && n === limits.cityMax
        ? `（${limits.cityName}滞在の最大）`
        : limits.cityName && n > limits.cityMax
          ? "（滞在都市を超える）"
          : "";
      return `<option value="${n}"${item.nights === n ? " selected" : ""}>${n}泊${note}</option>`;
    })
    .join("");
}

function geoQueryForItem(item: Item, target: GeoTarget): string {
  if (target === "from") return item.from.trim();
  if (target === "to") return item.to.trim();
  if (item.kind === "stay") return (item.place || item.mapQuery || item.title).trim();
  return (item.mapQuery || item.place || item.title).trim();
}

function conciseGeoLabel(label: string): string {
  return String(label || "").split(" / ")[0]?.trim() || String(label || "").trim();
}

/**
 * 都市検索の状態メッセージ。
 *
 * .pe-geo-results の見た目は中の button と small にしか付いていないので、
 * textContent で直に文字を入れると素のまま（余白も文字サイズも無し）に
 * なっていた。指定の当たる要素に包んで出す。
 */
function showCityGeoMessage(target: HTMLElement, text: string, kind?: "warn"): void {
  target.innerHTML =
    '<p class="pe-geo-msg' + (kind === "warn" ? " is-warn" : "") + '">' + escapeHtml(text) + "</p>";
}


// ---- レンダリング: 都市（ルート） ---------------------------------------

function dayOptions(selected: string): string {
  return `<option value="">—</option>` + model.days
    .map((d) => {
      const dt = parseISO(d.date);
      const label = dt ? `${dt.getMonth() + 1}/${dt.getDate()}(${weekday(dt)})` : d.date;
      return `<option value="${d.date}"${d.date === selected ? " selected" : ""}>${label}</option>`;
    })
    .join("");
}


document.querySelectorAll<HTMLElement>(".pe-step").forEach((el, i) => {
  el.addEventListener("click", () => setViewStep(i + 1));
});

document.querySelector<HTMLButtonElement>("[data-step-prev]")?.addEventListener("click", () => {
  setViewStep(state.viewStep - 1);
});

document.querySelector<HTMLButtonElement>("[data-step-next]")?.addEventListener("click", () => {
  const done = stepCompletion();
  if (state.viewStep >= 3) {
    publish();
    return;
  }
  if (!done[state.viewStep - 1]) return;
  setViewStep(state.viewStep + 1);
});

function renderCities(): void {
  updateSteps();
  cityOptions.innerHTML = model.cities.map((c) => `<option value="${escapeHtml(c.name)}">`).join("");
  if (!model.cities.length) {
    citiesEl.innerHTML = "";
    return;
  }
  const hasDays = model.days.length > 0;
  citiesEl.innerHTML = model.cities
    .map((c, i) => {
      const noGeo = hasLatLng(c.lat, c.lng) ? "" : " no-geo";
      const dateCtl = hasDays
        ? `<span class="pe-city-dates">` +
          `<span class="pe-city-dateicon">${icon("calendarDays")}</span>` +
          `<select data-city-from="${c.id}" aria-label="開始日">${dayOptions(c.fromDate)}</select>` +
          `<span class="pe-city-sep">${icon("arrowLongRight")}</span>` +
          `<select data-city-to="${c.id}" aria-label="終了日">${dayOptions(c.toDate)}</select>` +
          `</span>`
        : "";
      return `<div class="pe-city${noGeo}" data-city="${c.id}">` +
        `<span class="pe-city-n">${i + 1}</span>` +
        `<input class="pe-city-name" data-city-name="${c.id}" value="${escapeHtml(c.name)}" placeholder="都市名" aria-label="都市名">` +
        `<button class="pe-mini pe-city-action" type="button" data-city-geo="${c.id}" title="地図で探す" aria-label="地図で探す">${icon("mapPin")}</button>` +
        dateCtl +
        `<button class="pe-icon-btn danger pe-city-action" type="button" data-city-del="${c.id}" aria-label="削除">${icon("xCircle")}</button>` +
        (noGeo
          ? `<p class="pe-city-nogeo" data-city-nogeo="${c.id}">地図に未登録です。` +
            `<button class="pe-mini" type="button" data-city-pin="${c.id}">${icon("mapPin")}<span>地図で指定</span></button>` +
            `</p>`
          : "") +
        `<div class="pe-geo-results pe-city-results" data-city-geores="${c.id}" hidden></div>` +
        `</div>`;
    })
    .join("");
}

const cityGeoCache = new Map<number, GeoResult[]>();
const cityGeoRequestSeq = new Map<number, number>();

async function searchCity(city: City): Promise<void> {
  const query = city.name.trim();
  if (!query) return;
  const requestId = (cityGeoRequestSeq.get(city.id) || 0) + 1;
  cityGeoRequestSeq.set(city.id, requestId);
  const originalName = city.name;
  const resultsEl = citiesEl.querySelector<HTMLElement>(`[data-city-geores="${city.id}"]`);
  const button = citiesEl.querySelector<HTMLButtonElement>(`[data-city-geo="${city.id}"]`);
  if (button) button.setAttribute("aria-busy", "true");
  if (resultsEl) {
    resultsEl.hidden = false;
    showCityGeoMessage(resultsEl, "候補を検索中…");
  }
  try {
    const results = await geocodeSearch(query, {
      countryCode: countryFromText(query) || undefined,
      purpose: "city",
    });
    if (cityGeoRequestSeq.get(city.id) !== requestId || city.name !== originalName || !model.cities.includes(city)) return;
    cityGeoCache.set(city.id, results);
    if (!resultsEl) return;
    if (!results.length) {
      showCityGeoMessage(resultsEl, "都市候補が見つかりませんでした。国名を加えて再検索してください。", "warn");
      return;
    }
    resultsEl.innerHTML = results.map((result, index) =>
      `<button type="button" data-city-geo-pick="${city.id}" data-idx="${index}">` +
      `<b>候補 ${index + 1}</b><small>${escapeHtml(result.label)}</small></button>`,
    ).join("") + `<small class="pe-geo-attribution">${escapeHtml(geocodingAttribution(results))}</small>`;
  } catch (error) {
    if (cityGeoRequestSeq.get(city.id) === requestId && resultsEl) {
      showCityGeoMessage(resultsEl, errorMessage(error) || "都市検索に失敗しました", "warn");
    }
  } finally {
    if (cityGeoRequestSeq.get(city.id) === requestId && button) button.removeAttribute("aria-busy");
  }
}


// ---- AI で下書きを作る ---------------------------------------------------


type AiPreferences = db.ItineraryAiPreferences;
const aiConsultation = new AiConsultationState();
let aiErrorTimer: number | null = null;
let aiErrorHandler: (() => void | Promise<void>) | null = null;

aiRunIcon.innerHTML = icon("sparkles");

/** 考えている間の見た目。ボタンごと状態を持たせる。 */
function setAiBusy(busy: boolean, label = "考えています"): void {
  aiRun.disabled = busy;
  aiBuild.disabled = busy;
  aiRun.classList.toggle("is-busy", busy);
  aiRunLabel.textContent = busy ? label : "AI生成する";
  aiBar.hidden = !busy;
}

function clearAiError(): void {
  if (aiErrorTimer !== null) window.clearInterval(aiErrorTimer);
  aiErrorTimer = null;
  aiErrorHandler = null;
  aiError.hidden = true;
  aiErrorAction.hidden = true;
  aiErrorAction.disabled = false;
  aiErrorReference.hidden = true;
}

function setAiStatus(text: string, kind?: "warn" | "ok"): void {
  clearAiError();
  aiStatus.textContent = text;
  aiStatus.className = "pe-ai-status" + (kind ? " is-" + kind : "");
}

function showAiError(error: unknown, phase: AiErrorPhase): void {
  clearAiError();
  const source = error instanceof db.ApiRequestError
    ? error
    : { message: errorMessage(error), code: "request_failed", retryable: false };
  const guidance = aiErrorGuidance(source, phase);
  aiStatus.textContent = "";
  aiStatus.className = "pe-ai-status";
  aiError.hidden = false;
  aiErrorTitle.textContent = guidance.title;
  aiErrorMessage.textContent = guidance.message;
  aiErrorReference.hidden = !guidance.requestId;
  aiErrorReference.textContent = guidance.requestId ? `問い合わせ番号: ${guidance.requestId}` : "";

  if (guidance.action === "contact_support") {
    aiErrorAction.hidden = true;
    return;
  }
  aiErrorAction.hidden = false;
  aiErrorHandler = guidance.action === "retry"
    ? () => { void (phase === "candidates" ? startAiConsultation() : runAiDraft()); }
    : guidance.action === "restart"
      ? () => { resetAiConsultation(); aiArea.focus(); }
      : guidance.action === "sign_in"
        ? () => {
          window.open(
            "login.html?returnTo=" + encodeURIComponent("plan-editor.html" + location.search),
            "_blank",
            "noopener",
          );
        }
        : guidance.action === "external_ai"
          ? async () => {
            aiImportDetails.open = true;
            openExternalAi("chatgpt");
            const copied = await copyExternalAiPrompt(externalAiCreatePrompt());
            setAiStatus(
              copied
                ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
                : "質問文を表示しました。すべてコピーしてChatGPTへ貼り付けてください。",
              copied ? "ok" : "warn",
            );
          }
        : () => {
          clearAiError();
          if (phase === "candidates") aiNote.focus();
          else aiExtra.focus();
        };

  if (!guidance.retryAfter) {
    aiErrorAction.textContent = guidance.actionLabel;
    return;
  }
  const availableAt = Date.now() + guidance.retryAfter * 1000;
  const updateCountdown = (): void => {
    const remaining = Math.max(0, Math.ceil((availableAt - Date.now()) / 1000));
    aiErrorAction.disabled = remaining > 0;
    aiErrorAction.textContent = remaining > 0
      ? `${retryWaitLabel(remaining)}後に再試行できます`
      : guidance.actionLabel;
    if (!remaining && aiErrorTimer !== null) {
      window.clearInterval(aiErrorTimer);
      aiErrorTimer = null;
    }
  };
  updateCountdown();
  if (aiErrorAction.disabled) aiErrorTimer = window.setInterval(updateCountdown, 1000);
}

aiErrorAction.addEventListener("click", () => {
  if (aiErrorAction.disabled) return;
  const handler = aiErrorHandler;
  clearAiError();
  void handler?.();
});

function selectedAiCandidates(): db.ItineraryOptions["candidates"] {
  return aiConsultation.selectedCandidates();
}

function aiCandidateGroups(): { city: string; candidates: db.ItineraryOptions["candidates"] }[] {
  return aiConsultation.candidateGroups();
}

function unselectedAiCities(): string[] {
  return aiConsultation.unselectedCities();
}

function aiPreferences(): AiPreferences {
  const pace = root.querySelector<HTMLInputElement>('input[name="ai-pace"]:checked')?.value || "標準";
  return {
    pace: pace as AiPreferences["pace"],
    interests: Array.from(root.querySelectorAll<HTMLInputElement>('input[name="ai-interest"]:checked'))
      .map((input) => input.value),
    walking: aiWalking.value as AiPreferences["walking"],
    transport: aiTransport.value as AiPreferences["transport"],
    extra: aiExtra.value.trim() || undefined,
  };
}

function aiBaseInputForExternal(): db.ItineraryAiBaseInput | null {
  const cities = model.cities
    .filter((city) => city.name.trim())
    .map((city) => ({ name: city.name.trim(), from_date: city.fromDate, to_date: city.toDate }));
  const area = aiArea.value.trim() || cities.map((city) => city.name).join("、") || model.title.trim();
  return area || model.startDate || model.endDate
    ? {
      area,
      start_date: model.startDate,
      end_date: model.endDate,
      note: aiNote.value.trim() || undefined,
      cities,
    }
    : null;
}

function externalAiCreatePrompt(): string {
  return buildExternalAiCreatePrompt({
    base: aiBaseInputForExternal(),
    title: model.title,
    members: model.members,
    selectedCandidates: selectedAiCandidates(),
    preferences: aiConsultation.stage === "preferences" ? aiPreferences() : undefined,
  });
}

function aiBubble(role: "assistant" | "user", text: string): string {
  // チャットの見た目に寄せる: AI は左にアイコン＋吹き出し、利用者は右寄せ。
  // 名前は毎回出さず、話し手はアイコンと左右で示す。
  const avatar = role === "assistant"
    ? `<span class="pe-ai-avatar" aria-hidden="true">${icon("sparkles")}</span>`
    : "";
  return `<div class="pe-ai-line is-${role}">` +
    avatar +
    `<div class="pe-ai-bubble is-${role}">` +
    `<b class="pe-ai-who">${role === "assistant" ? "AIプランナー" : "あなた"}</b>` +
    `<p>${escapeHtml(text)}</p>` +
    "</div></div>";
}

/** AI が考えている間に出す、点が動く吹き出し。 */
function aiTypingBubble(): string {
  return `<div class="pe-ai-line is-assistant">` +
    `<span class="pe-ai-avatar" aria-hidden="true">${icon("sparkles")}</span>` +
    `<div class="pe-ai-bubble is-assistant is-typing" role="status" aria-label="AI が考えています">` +
    "<i></i><i></i><i></i>" +
    "</div></div>";
}

function renderAiThread(): void {
  if (aiConsultation.stage === "idle") {
    aiThread.innerHTML = "";
    return;
  }
  const selectedNames = selectedAiCandidates().map((candidate) => candidate.name);
  const messages = [aiBubble("assistant", aiConsultation.options?.message || "候補から行きたい場所を選んでください。")];
  if (["preferences", "building", "done"].includes(aiConsultation.stage)) {
    messages.push(aiBubble("user", `行きたい場所: ${selectedNames.join("、")}`));
    messages.push(aiBubble("assistant", "選択を受け取りました。最後に旅のペースと移動条件を決めてください。"));
  }
  if (["building", "done"].includes(aiConsultation.stage)) {
    const preferences = aiPreferences();
    const condition = [
      `ペースは${preferences.pace}`,
      `徒歩は${preferences.walking}`,
      `移動は${preferences.transport}`,
      preferences.interests.length ? `興味は${preferences.interests.join("・")}` : "",
      preferences.extra || "",
    ].filter(Boolean).join("、");
    messages.push(aiBubble("user", condition));
    messages.push(aiBubble("assistant", aiConsultation.stage === "done"
      ? "行程を作成しました。相談はここで完了です。"
      : "条件を反映して、都市間移動を含む行程を組み立てています。"));
  }
  if (aiConsultation.stage === "building") messages.push(aiTypingBubble());
  aiThread.innerHTML = messages.join("");
  // 会話が伸びたら最後の発言が見えるようにする
  aiThread.scrollTop = aiThread.scrollHeight;
}

function setAiStage(stage: AiStage): void {
  aiConsultation.stage = stage;
  aiIntro.hidden = stage !== "idle";
  aiDialog.hidden = stage === "idle";
  aiCandidatesStage.hidden = stage !== "candidates";
  aiPreferencesStage.hidden = stage !== "preferences";
  aiDoneStage.hidden = stage !== "done";
  const index = stage === "idle" || stage === "candidates" ? 0 : stage === "preferences" ? 1 : 2;
  root.querySelectorAll<HTMLElement>("[data-ai-flow]").forEach((item, itemIndex) => {
    item.classList.toggle("is-current", itemIndex === index);
    item.classList.toggle("is-done", itemIndex < index || stage === "done");
  });
  renderAiThread();
}

function updateAiSelection(): void {
  const count = aiConsultation.selectedIds.size;
  const groups = aiCandidateGroups();
  const missing = unselectedAiCities();
  aiSelection.textContent = missing.length
    ? `各都市から1件以上選んでください。未選択: ${missing.join("、")}`
    : `${groups.length}都市から合計${count}件選択中。次にペースや移動条件を指定します。`;
  aiSelection.classList.toggle("is-warn", missing.length > 0);
  aiToPreferences.disabled = count === 0 || missing.length > 0;
  for (const group of groups) {
    const selectedCount = group.candidates.filter((candidate) => aiConsultation.selectedIds.has(candidate.id)).length;
    const counter = aiCandidateList.querySelector<HTMLElement>(`[data-ai-city-count="${CSS.escape(group.city)}"]`);
    if (counter) counter.textContent = `${selectedCount}/${group.candidates.length}件選択`;
  }
}

/**
 * 候補の種類ごとの色とアイコン。
 * 一覧が文字だけだと似た箱が並ぶので、種類が目で分かるようにする。
 */
const AI_CATEGORY_LOOK: Record<string, { icon: IconName; tone: string }> = {
  定番: { icon: "star", tone: "classic" },
  文化: { icon: "buildingOffice2", tone: "culture" },
  自然: { icon: "sun", tone: "nature" },
  グルメ: { icon: "cake", tone: "food" },
  体験: { icon: "sparkles", tone: "activity" },
  買い物: { icon: "shoppingBag", tone: "shopping" },
};

function renderAiCandidates(): void {
  aiCandidateList.innerHTML = aiCandidateGroups().map((group) =>
    `<section class="pe-ai-city-group">` +
      `<header><h3>${icon("mapPin")}<span>${escapeHtml(group.city)}</span></h3>` +
      `<span data-ai-city-count="${escapeHtml(group.city)}">0/${group.candidates.length}件選択</span></header>` +
      `<div class="pe-ai-city-options">` + group.candidates.map((candidate) => {
        const look = AI_CATEGORY_LOOK[candidate.category] || { icon: "mapPin" as IconName, tone: "other" };
        return `<label class="pe-ai-candidate" data-tone="${look.tone}">` +
          `<input type="checkbox" data-ai-candidate value="${escapeHtml(candidate.id)}">` +
          `<span class="pe-ai-candidate-check">${icon("check")}</span>` +
          `<span class="pe-ai-candidate-body">` +
          `<span class="pe-ai-candidate-top">` +
          `<b>${escapeHtml(candidate.name)}</b>` +
          `<em class="pe-ai-cat">${icon(look.icon)}<span>${escapeHtml(candidate.category)}</span></em>` +
          "</span>" +
          `<small>${icon("clock")}<span>${escapeHtml(formatDurationMinutes(candidate.duration_minutes))}</span></small>` +
          `<p>${escapeHtml(candidate.reason)}</p></span>` +
          "</label>";
      }).join("") + `</div></section>`
  ).join("");
  updateAiSelection();
}

function resetAiConsultation(): void {
  if (aiConsultation.stage === "building") return;
  aiConsultation.reset();
  setAiStatus("");
  setAiStage("idle");
}

function contextualMapQuery(place: string, area: string): string {
  const query = place.trim();
  const city = area.trim();
  if (!query || !city || query.normalize("NFKC").toLowerCase().includes(city.normalize("NFKC").toLowerCase())) {
    return query;
  }
  return `${query}, ${city}`;
}

function aiCoordinate(value: number | null | undefined, minimum: number, maximum: number): string {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= minimum && number <= maximum
    ? String(number)
    : "";
}

/** 生成結果を編集中のモデルへ流し込む。 */
function applyItineraryDraft(draft: db.ItineraryDraft): void {
  model.cities = draft.cities.map((city) => {
    const name = city.name.trim();
    const coords = TripPlans.coordsFor(name);
    const latitude = aiCoordinate(city.latitude, -90, 90);
    const longitude = aiCoordinate(city.longitude, -180, 180);
    return {
      id: state.seq++,
      name,
      lat: latitude || (coords ? String(coords.lat) : ""),
      lng: longitude || (coords ? String(coords.lng) : ""),
      fromDate: city.from_date || "",
      toDate: city.to_date || city.from_date || "",
    };
  });
  const byDate = new Map(draft.days.map((day) => [day.date, day]));
  for (const day of model.days) {
    const source = byDate.get(day.date);
    if (!source) {
      // 置き換えに同意してもらっているので、生成が届かなかった日は空にする。
      // 前の予定が混ざったまま残るほうが分かりにくい。
      day.items = [];
      day.stay = null;
      continue;
    }
    if (source.area) day.area = source.area;
    const kinds: ItemKind[] = ["sight", "food", "move", "stay", "todo", "form"];
    const items = source.items.filter((item) => kinds.includes(item.kind as ItemKind));
    // 宿泊はその日の「錨」として別枠に持つ。予定の列には入れない。
    const stay = items.find((item) => item.kind === "stay");
    day.items = items
      .filter((item) => item.kind !== "stay")
      .map((item) => {
        const created = newItem(item.kind as ItemKind, {
          time: item.time || "",
          title: item.title || "",
          place: item.place || "",
          mapQuery: item.kind === "move"
            ? item.address || ""
            : item.address || contextualMapQuery(item.place || item.title, source.area),
          lat: aiCoordinate(item.latitude, -90, 90),
          lng: aiCoordinate(item.longitude, -180, 180),
          note: item.note || "",
          ...(item.kind === "move" ? {
            ...splitMoveTitle(item.title),
            from: item.from_place || splitMoveTitle(item.title).from || "",
            fromLat: aiCoordinate(item.from_latitude, -90, 90),
            fromLng: aiCoordinate(item.from_longitude, -180, 180),
            to: item.to_place || splitMoveTitle(item.title).to || "",
            toLat: aiCoordinate(item.to_latitude ?? item.latitude, -90, 90),
            toLng: aiCoordinate(item.to_longitude ?? item.longitude, -180, 180),
            transport: item.transport || "",
            duration: formatDurationMinutes(item.duration_minutes),
          } : {}),
        });
        if (created.kind === "move") {
          autoCoords(created, "from");
          autoCoords(created, "to");
        } else {
          autoCoords(created, "place");
        }
        return created;
      });
    day.stay = stay
      ? newItem("stay", {
          title: stay.title || "",
          place: stay.place || "",
          mapQuery: stay.address || contextualMapQuery(stay.place || stay.title, source.area),
          lat: aiCoordinate(stay.latitude, -90, 90),
          lng: aiCoordinate(stay.longitude, -180, 180),
          note: stay.note || "",
          nights: 1,
        })
      : null;
    if (day.stay) autoCoords(day.stay, "place");
  }
}

interface AiMapRegistrationSummary extends AiMapGeocodeSummary {
  available: boolean;
}

/** AIが登録した施設名を住所へ正規化し、地図用座標と完全な住所文字列をモデルへ付与する。 */
async function registerAiDraftPlacesOnMap(): Promise<AiMapRegistrationSummary> {
  const placeItems = model.days.flatMap((day) => [
    ...day.items.map((item) => ({ day, item })),
    ...(day.stay ? [{ day, item: day.stay }] : []),
  ]);
  const targetCount = model.cities.filter((city) => city.name.trim()).length + placeItems.reduce((count, { item }) => {
    if (item.kind === "move") return count + Number(Boolean(item.from.trim())) + Number(Boolean(item.to.trim()));
    return count + Number(["sight", "food", "stay"].includes(item.kind) && Boolean(geoQueryForItem(item, "place")));
  }, 0);
  if (!automaticGeocodingAvailable(MAPBOX_TOKEN)) {
    return { available: false, attempted: targetCount, resolved: 0, unresolved: targetCount };
  }

  const citySummary = await resolveAiMapGeocodeJobs(
    model.cities.map((city) => ({
      query: city.name,
      context: { countryCode: countryFromText(city.name) || undefined, purpose: "city" as const },
      apply: (result: GeoResult) => {
        city.lat = String(result.lat);
        city.lng = String(result.lng);
      },
    })),
    (query, context) => geocodeSearch(query, context, true),
  );

  const jobs = placeItems.flatMap(({ day, item }) => {
    const targets: GeoTarget[] = item.kind === "move" ? ["from", "to"] : ["place"];
    if (item.kind !== "move" && !["sight", "food", "stay"].includes(item.kind)) return [];
    return targets.flatMap((target) => {
      const query = geoQueryForItem(item, target);
      if (!query) return [];
      return [{
        query,
        context: geocodeContextForDay(day, item, target),
        apply: (result: GeoResult) => {
          const [latKey, lngKey] = latLngKeys(target);
          item[latKey] = String(result.lat);
          item[lngKey] = String(result.lng);
          if (target === "place") {
            // providerの完全な住所を、Google Mapsリンクと再保存にも使う。
            item.mapQuery = result.label;
            if (!item.place.trim()) item.place = conciseGeoLabel(result.label);
          }
        },
      }];
    });
  });
  const itemSummary = await resolveAiMapGeocodeJobs(
    jobs,
    (query, context) => geocodeSearch(query, context, true),
  );
  return {
    available: true,
    attempted: citySummary.attempted + itemSummary.attempted,
    resolved: citySummary.resolved + itemSummary.resolved,
    unresolved: citySummary.unresolved + itemSummary.unresolved,
  };
}

/** 「A → B」の移動タイトルから出発地・到着地を拾う。 */
function splitMoveTitle(title: string): Partial<Item> {
  const parts = String(title || "").split(/[→⇒]|->/).map((s) => s.trim()).filter(Boolean);
  return parts.length >= 2 ? { from: parts[0], to: parts[1] } : {};
}

function aiBaseInput(): db.ItineraryAiBaseInput | null {
  const cities = model.cities
    .filter((city) => city.name.trim())
    .map((city) => ({ name: city.name.trim(), from_date: city.fromDate, to_date: city.toDate }));
  const area = aiArea.value.trim() || cities.map((city) => city.name).join("、") || model.title.trim();
  if (!area) {
    setAiStatus("行き先を入れるか、訪問地を登録してください", "warn");
    aiArea.focus();
    return null;
  }
  if (!model.startDate || !model.endDate) {
    setAiStatus("先に期間を決めてください", "warn");
    return null;
  }
  return {
    area,
    start_date: model.startDate,
    end_date: model.endDate,
    note: aiNote.value.trim() || undefined,
    cities,
  };
}

async function startAiConsultation(): Promise<void> {
  if (state.editorLocked || aiConsultation.stage !== "idle") return;
  const input = aiBaseInput();
  if (!input) return;

  setAiBusy(true, "候補を探しています");
  setAiStatus("旅程を作る前に、行きたい場所の候補を絞っています。");
  try {
    aiConsultation.start(await db.suggestItineraryOptions(input));
    renderAiCandidates();
    setAiStage("candidates");
    setAiStatus("候補を選ぶと、次にペースや移動条件を指定できます。", "ok");
  } catch (error) {
    showAiError(error, "candidates");
  } finally {
    setAiBusy(false);
  }
}

async function runAiDraft(): Promise<void> {
  if (state.editorLocked || aiConsultation.stage !== "preferences") return;
  const input = aiBaseInput();
  if (!input) return;
  const selected = selectedAiCandidates();
  const missing = unselectedAiCities();
  if (!selected.length || missing.length) {
    setAiStage("candidates");
    setAiStatus(`各都市から1件以上選んでください。未選択: ${missing.join("、")}`, "warn");
    return;
  }
  const filled = model.days.some((day) => day.items.length || day.stay);
  if (filled && !window.confirm("現在の行程を、AIが作る新しい行程に置き換えます。よろしいですか。")) return;

  setAiStage("building");
  setAiBusy(true);
  setAiStatus("選んだ場所と条件から、都市間移動を含む行程を作っています。");
  try {
    const draft = await db.generateItinerary({
      ...input,
      consultation_token: aiConsultation.options?.consultation_token || "",
      selected_candidate_ids: selected.map((candidate) => candidate.id),
      preferences: aiPreferences(),
    });
    applyItineraryDraft(draft);
    markDirty();
    renderCities();
    renderDays();
    refreshMap(true);
    setAiStatus("行程を作成しました。施設の住所を確認して地図へ登録しています。");
    await registerAiDraftPlacesOnMap();
    renderCities();
    renderDays();
    refreshMap(true);
    // 先行する自動保存があっても、AI適用後のrevisionがDBへ届くまで待つ。
    const saved = await persist(true);
    setAiStage("done");
    // 完了カードだけで十分なので、成功ログは残さない。保存失敗だけは操作が必要なため表示する。
    setAiStatus(saved ? "" : "行程を作成しましたが保存できませんでした。", saved ? undefined : "warn");
  } catch (error) {
    if (error instanceof db.ApiRequestError && error.code === "invalid_ai_input") {
      aiConsultation.reset();
      setAiStage("idle");
    } else {
      setAiStage("preferences");
    }
    showAiError(error, "itinerary");
  } finally {
    setAiBusy(false);
  }
}

async function importExternalAiDraft(): Promise<void> {
  if (state.editorLocked) {
    aiImportStatus.textContent = "この計画を編集する権限がありません。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
    return;
  }
  const raw = aiImportJson.value.trim();
  if (!raw) {
    aiImportStatus.textContent = "ChatGPTから返ってきた答えを貼り付けてください。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
    return;
  }
  let imported: ReturnType<typeof parseExternalAiCreateJson>;
  try {
    imported = parseExternalAiCreateJson(raw, {
      startDate: model.startDate,
      endDate: model.endDate,
      title: model.title,
    });
  } catch (error) {
    aiImportStatus.textContent = errorMessage(error) || "旅行案を読み取れませんでした。答えを最初から最後までコピーして、もう一度お試しください。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
    return;
  }

  const filled = model.days.some((day) => day.items.length || day.stay);
  if (filled && !window.confirm("現在の行程を、貼り付けた旅行案で置き換えます。よろしいですか。")) return;

  aiImportApply.disabled = true;
  aiImportStatus.textContent = "旅行案を取り込んでいます…";
  aiImportStatus.className = "pe-ai-import-status";
  try {
    if (imported.title) model.title = imported.title;
    model.startDate = imported.startDate;
    model.endDate = imported.endDate;
    rebuildDays();
    applyItineraryDraft(imported.draft);
    markDirty();
    syncBasicInputs();
    renderCities();
    renderDays();
    refreshMap(true);
    aiImportStatus.textContent = "行程に反映しました。住所と座標を確認しています…";
    await registerAiDraftPlacesOnMap();
    renderCities();
    renderDays();
    refreshMap(true);
    const saved = await persist(true);
    aiImportStatus.textContent = saved
      ? "旅行案を取り込み、保存しました。"
      : "旅行案は取り込めましたが、保存できませんでした。";
    aiImportStatus.className = "pe-ai-import-status" + (saved ? " is-ok" : " is-warn");
    setViewStep(3);
  } catch (error) {
    aiImportStatus.textContent = errorMessage(error) || "旅行案を読み取れませんでした。答えを最初から最後までコピーして、もう一度お試しください。";
    aiImportStatus.className = "pe-ai-import-status is-warn";
  } finally {
    aiImportApply.disabled = false;
  }
}

aiRun.addEventListener("click", () => { void startAiConsultation(); });
aiImportOpen.addEventListener("click", async () => {
  openExternalAi("chatgpt");
  const copied = await copyExternalAiPrompt(externalAiCreatePrompt());
  aiImportStatus.textContent = copied
    ? "質問文をコピーしました。開いたChatGPTへ貼り付けてください。"
    : "表示された質問文をすべてコピーし、ChatGPTへ貼り付けてください。";
  aiImportStatus.className = "pe-ai-import-status" + (copied ? " is-ok" : " is-warn");
});
aiImportApply.addEventListener("click", () => { void importExternalAiDraft(); });
watchComposition(aiArea);
aiArea.addEventListener("keydown", (e) => {
  if (isComposingKey(e)) return;
  if (e.key === "Enter") { e.preventDefault(); void startAiConsultation(); }
});
aiCandidateList.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.matches("[data-ai-candidate]")) return;
  if (input.checked) {
    aiConsultation.select(input.value, true);
    setAiStatus("");
  } else {
    aiConsultation.select(input.value, false);
  }
  updateAiSelection();
});
aiToPreferences.addEventListener("click", () => {
  const missing = unselectedAiCities();
  if (!aiConsultation.selectedIds.size || missing.length) {
    setAiStatus(`各都市から1件以上選んでください。未選択: ${missing.join("、")}`, "warn");
    return;
  }
  setAiStatus("");
  setAiStage("preferences");
});
qs<HTMLButtonElement>("[data-ai-back-candidates]").addEventListener("click", () => {
  setAiStatus("");
  setAiStage("candidates");
});
qs<HTMLButtonElement>("[data-ai-reset]").addEventListener("click", resetAiConsultation);
aiBuild.addEventListener("click", () => { void runAiDraft(); });
qs<HTMLButtonElement>("[data-ai-show-itinerary]").addEventListener("click", () => setViewStep(3));

async function addCity(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const local = TripPlans.coordsFor(trimmed);
  const fromDate = cityDateDefault(model.cities.length);
  const city: City = {
    id: state.seq++,
    name: trimmed,
    lat: local ? String(local.lat) : "",
    lng: local ? String(local.lng) : "",
    fromDate,
    toDate: fromDate,
  };
  model.cities.push(city);
  // 追加できた時点で入力欄を空にする。呼び出し側まかせだと
  // 経路が増えたときに消し忘れる。
  cityInput.value = "";
  markDirty();
  renderCities();
  refreshMap(false);
  if (!local) {
    await searchCity(city);
  } else {
    refreshMap(true);
  }
}

// ---- レンダリング: 日とタイムライン -------------------------------------

function dayHeader(day: Day, index: number): string {
  const d = parseISO(day.date);
  const dayName = `Day ${index + 1}`;
  const cover = stayCovering(index);
  const city = cityForDate(day.date);
  const area = (city ? city.name : "") || day.area || (cover && cover.stay.title ? cover.stay.title : "") || "エリア未設定";
  const stay = cover && cover.stay.title
    ? cover.stay.title + (cover.stay.nights > 1 ? `（${cover.stay.nights}泊）` : "")
    : "宿 未定";
  return (
    `<div class="pe-day-head">` +
    `<div class="pe-day-badge"><b>${dayName}</b><span>${d ? `${d.getMonth() + 1}/${d.getDate()}(${weekday(d)})` : ""}</span></div>` +
    `<div class="pe-day-route">` +
    `<b>${escapeHtml(area)}</b>` +
    `<span>${icon("buildingOffice2")} ${escapeHtml(stay)}</span>` +
    `</div>` +
    `<div class="pe-day-tools">` +
    `<button class="pe-icon-btn" type="button" data-act="sort-time" data-day="${index}" title="時刻で並べ替え">${icon("clock")}</button>` +
    `<button class="pe-icon-btn" type="button" data-act="copy-prev" data-day="${index}" title="前日をコピー"${index === 0 ? " disabled" : ""}>${icon("documentDuplicate")}</button>` +
    `</div>` +
    `</div>`
  );
}

/**
 * 一部メンバーだけの予定に出す名前バッジ。全員（空）は通常なにも出さないが、
 * 班タブで絞っているときだけ「全員」と明示する（どの班にも表示される予定だと分かるように）。
 */
function rowMembersBadge(item: Item): string {
  if (!item.members.length) {
    return renderingWithTrack ? `<span class="pe-row-members is-all">全員</span>` : "";
  }
  const names = item.members.map((id) => db.nameOf(id)).filter(Boolean);
  return `<span class="pe-row-members" title="この予定の対象メンバー">${escapeHtml(names.join("・") || "一部メンバー")}</span>`;
}

function rowSummary(item: Item): string {
  const k = KINDS[item.kind];
  if (item.kind === "move") {
    const from = item.from || "出発";
    const to = item.to || "到着";
    const means = item.transport.trim();
    const meansIcon = means
      ? `<span class="mid" title="${escapeHtml(means)}" aria-label="${escapeHtml(means)}">` +
        icon(TRANSPORT_ICONS[means] || "arrowsRightLeft") +
        "</span>"
      : "";
    const dur = item.duration.trim() ? `<span class="dur">${escapeHtml(item.duration)}</span>` : "";
    return (
      `<span class="pe-chip" data-kind="move">${icon(k.icon)}${k.label}</span>` +
      `<span class="pe-row-time">${escapeHtml(item.time)}</span>` +
      `<span class="pe-seg"><span class="ep">${escapeHtml(from)}</span>` +
      `<span class="arr">${icon("arrowLongRight")}</span>` +
      meansIcon +
      dur +
      `<span class="arr">${icon("arrowLongRight")}</span>` +
      `<span class="ep">${escapeHtml(to)}</span></span>` +
      rowMembersBadge(item) +
      `<span class="pe-row-caret">${icon("chevronDown")}</span>`
    );
  }
  const title = item.title || item.place;
  const titleCls = title ? "" : " is-empty";
  const titleText = title || `${itemNameLabel(item.kind)}未入力`;
  const sub = item.place && item.title ? ` <small>${escapeHtml(item.place)}</small>` : "";
  return (
    `<span class="pe-chip" data-kind="${item.kind}">${icon(k.icon)}${k.label}</span>` +
    `<span class="pe-row-time">${escapeHtml(item.time)}</span>` +
    `<span class="pe-row-title${titleCls}">${escapeHtml(titleText)}${sub}</span>` +
    rowMembersBadge(item) +
    `<span class="pe-row-caret">${icon("chevronDown")}</span>`
  );
}

function itemNameLabel(kind: ItemKind): string {
  if (kind === "stay") return "ホテル名";
  if (kind === "sight") return "観光地名";
  if (kind === "food") return "店名・食事名";
  if (kind === "todo") return "予定名";
  if (kind === "form") return "手続き名";
  return "タイトル";
}

function itemNamePlaceholder(kind: ItemKind): string {
  if (kind === "stay") return "例: 八戸グランドホテル";
  if (kind === "sight") return "例: エッフェル塔";
  if (kind === "food") return "例: 〇〇レストラン / 海鮮丼";
  if (kind === "todo") return "例: 予約確認";
  if (kind === "form") return "例: 入国書類の提出";
  return "例: 中尊寺を拝観";
}

function rowControls(item: Item): string {
  return (
    `<span class="pe-grip" data-grip aria-label="ドラッグで並べ替え">${icon("bars3")}</span>` +
    rowSummary(item) +
    `<button class="pe-row-remove" type="button" data-act="remove" data-item="${item.id}" title="削除" aria-label="削除">${icon("trash")}</button>`
  );
}

function fieldInput(item: Item, key: ItemStrKey, ph: string): string {
  const maxLength = key === "note" ? 5000 : key === "duration" || key === "transport" ? 60 : key === "time" ? 32 : 200;
  return `<input data-field="${key}" data-item="${item.id}" maxlength="${maxLength}" value="${escapeHtml(item[key])}" placeholder="${escapeHtml(ph)}">`;
}

function placeBlock(item: Item, target: GeoTarget, label: string, ph: string): string {
  const key: ItemStrKey = target === "from" ? "from" : target === "to" ? "to" : "place";
  return (
    `<div class="pe-field pe-place-field c2" data-place-field="${item.id}-${target}"><span>${label}</span>` +
    `<div class="pe-place-input-wrap">` +
    fieldInput(item, key, ph) +
    `<span class="pe-place-loading" aria-hidden="true"></span>` +
    `</div>` +
    `<div class="pe-place-tools">` +
    `<button class="pe-mini" type="button" data-act="geo" data-item="${item.id}" data-target="${target}">${icon("magnifyingGlass")}<span>検索</span></button>` +
    `<button class="pe-mini" type="button" data-act="geo-arm" data-item="${item.id}" data-target="${target}">${icon("mapPin")}<span>地図で指定</span></button>` +
    `</div>` +
    `<div class="pe-geo-status" data-geo="${item.id}-${target}"></div>` +
    `<div class="pe-geo-results" data-geores="${item.id}-${target}" hidden></div>` +
    `</div>`
  );
}

/**
 * 予定ごとの対象メンバー選択チップ。空選択＝その日の在籍メンバー全員（既定）。
 * 途中合流の個人移動（例: たかしだけ東京→大阪）を共有行程の中に置くための例外指定。
 */
function memberPickerBlock(item: Item): string {
  const ids = model.memberIds.filter((id) => id && db.nameOf(id));
  if (ids.length < 2) return "";
  const all = !item.members.length;
  return (
    `<div class="pe-field c4 pe-item-members"><span>対象メンバー <em>任意</em></span>` +
    `<div class="pe-item-members-chips">` +
    `<button class="pe-mchip${all ? " is-on" : ""}" type="button" data-act="members-all" data-item="${item.id}">全員</button>` +
    ids.map((id) => {
      const on = item.members.includes(id);
      return `<button class="pe-mchip${on ? " is-on" : ""}" type="button" data-act="member-toggle" data-item="${item.id}" data-member="${escapeHtml(id)}">${escapeHtml(db.nameOf(id))}</button>`;
    }).join("") +
    `</div>` +
    `<p class="pe-item-members-note">一部の人だけの予定（途中合流の移動など）はここで選ぶ。未選択＝全員。</p>` +
    `</div>`
  );
}

function editForm(item: Item): string {
  const g = `<div class="pe-edit-grid">`;
  const end = `</div><div class="pe-edit-actions"><button class="pe-mini" type="button" data-act="close">${icon("check")}<span>完了</span></button></div>`;
  if (item.kind === "move") {
    return (
      g +
      placeBlock(item, "from", "出発地", "例: 盛岡駅") +
      placeBlock(item, "to", "到着地", "例: 八戸") +
      `<label class="pe-field"><span>手段</span><select data-field="transport" data-item="${item.id}">` +
        `<option value="">—</option>` +
        TRANSPORTS.map((t) => `<option value="${t}"${item.transport === t ? " selected" : ""}>${t}</option>`).join("") +
        `</select></label>` +
      `<label class="pe-field"><span>所要時間</span>${fieldInput(item, "duration", "例: 1h40m")}</label>` +
      `<label class="pe-field"><span>時刻 <em>任意</em></span>${fieldInput(item, "time", "例: 13:00 発")}</label>` +
      `<label class="pe-field c4"><span>メモ <em>任意</em></span>${fieldInput(item, "note", "予約番号など")}</label>` +
      memberPickerBlock(item) +
      end
    );
  }
  const timeLabel = item.kind === "food" ? "時刻 / 朝昼夜" : item.kind === "stay" ? "チェックイン" : "時刻";
  const nameLabel = itemNameLabel(item.kind);
  const namePlaceholder = itemNamePlaceholder(item.kind);
  const nightsSelect = item.kind === "stay"
    ? `<label class="pe-field"><span>泊数</span><select data-field="nights" data-item="${item.id}">` +
      stayNightOptions(item) +
      `</select></label>`
    : "";
  return (
    g +
    `<label class="pe-field c2"><span>${nameLabel}</span>${fieldInput(item, "title", namePlaceholder)}</label>` +
    `<label class="pe-field"><span>${timeLabel} <em>任意</em></span>${fieldInput(item, "time", item.kind === "food" ? "例: 夜" : "例: 10:00")}</label>` +
    nightsSelect +
    placeBlock(item, "place", "場所", "例: 平泉 / 中尊寺") +
    `<label class="pe-field c4"><span>メモ <em>任意</em></span>${fieldInput(item, "note", "当日見たい情報だけ")}</label>` +
    memberPickerBlock(item) +
    end
  );
}

function timelineNode(item: Item): string {
  const open = state.openItemId === item.id ? " is-open" : "";
  return (
    `<div class="pe-node${open}" data-kind="${item.kind}" data-node="${item.id}">` +
    `<span class="pe-dot"></span>` +
    `<div class="pe-row" role="button" tabindex="0" data-act="toggle" data-item="${item.id}">` +
    rowControls(item) +
    `</div>` +
    `<div class="pe-edit">${editForm(item)}</div>` +
    `</div>`
  );
}

function stayBand(index: number): string {
  const cover = stayCovering(index);
  if (!cover) return "";
  // 連泊の継続日（編集はチェックイン日で行う）
  if (cover.startIndex !== index) {
    return (
      `<div class="pe-stay pe-stay-cont">` +
      `<span class="pe-stay-ic">${icon("buildingOffice2")}</span>` +
      `<div class="pe-stay-main"><b>${escapeHtml(cover.stay.title || "連泊")}</b><span>同じ宿に滞在中（連泊）</span></div>` +
      `</div>`
    );
  }
  const stay = cover.stay;
  const open = state.openItemId === stay.id ? " is-open" : "";
  const title = stay.title || "ホテル名未入力";
  const titleCls = stay.title ? "" : " is-empty";
  const meta = [stay.time ? `IN ${stay.time}` : "", stay.nights > 1 ? `${stay.nights}泊` : "", stay.place].filter(Boolean).join(" ・ ");
  return (
    `<div class="pe-node${open}" data-kind="stay" data-node="${stay.id}">` +
    `<div class="pe-stay">` +
    `<span class="pe-stay-ic">${icon("buildingOffice2")}</span>` +
    `<button class="pe-stay-main" type="button" data-act="toggle" data-item="${stay.id}" style="border:0;background:none;text-align:left;cursor:pointer;padding:0;">` +
    `<b class="${titleCls}">${escapeHtml(title)}</b><span>${escapeHtml(meta || "この日の宿泊先")}</span>` +
    `</button>` +
    `<button class="pe-icon-btn danger" type="button" data-act="remove" data-item="${stay.id}" data-day="${index}" title="削除">${icon("trash")}</button>` +
    `</div>` +
    `<div class="pe-edit">${editForm(stay)}</div>` +
    `</div>`
  );
}

// ---- 参加者で行程が分かれる日の班タブ ------------------------------------
// ダッシュボードの表示と同じ day-tracks ロジックで班を割り、編集もタブで切り替える。
// 全員の予定（members 空か全員入り）はどの班のタブにも表示され、どちらからでも編集できる。

/** 日付 → 選択中の班キー。再描画をまたいで保持する。 */
const editTrackChoice = new Map<string, string>();
/** 班タブで絞った描画中か（rowMembersBadge が「全員」チップを出す判断に使う）。 */
let renderingWithTrack = false;

/** その日に在籍しているメンバー（参加期間 memberDates を反映）。 */
function presentIdsOnDate(date: string): string[] {
  const ids = model.memberIds.filter((id) => id && db.nameOf(id));
  return presentMemberIds(
    ids.map((id) => ({
      user_id: id,
      from_date: model.memberDates[id]?.from ?? null,
      to_date: model.memberDates[id]?.to ?? null,
    })),
    date,
  );
}

function dayTracksOf(day: Day): DayTrack[] {
  return dayTracks(day.items.map((item) => item.members), presentIdsOnDate(day.date));
}

function selectedEditTrack(day: Day): DayTrack | null {
  return pickTrack(dayTracksOf(day), editTrackChoice.get(day.date), currentAccount()?.id || "");
}

/** 班タブの表示名（本人は「あなた」、4人以上は他N人）。 */
function editTrackLabel(track: DayTrack): string {
  const you = currentAccount()?.id || "";
  const names: string[] = [];
  if (you && track.memberIds.includes(you)) names.push("あなた");
  for (const id of track.memberIds) {
    if (id === you) continue;
    const name = db.nameOf(id);
    if (name) names.push(name);
  }
  if (!names.length) return "そのほか";
  return names.slice(0, 3).join("・") + (names.length > 3 ? ` 他${names.length - 3}人` : "");
}

function dayTrackTabsHtml(day: Day, index: number): string {
  const tracks = dayTracksOf(day);
  if (!tracks.length) return "";
  const selected = selectedEditTrack(day);
  return (
    `<div class="pe-track-tabs" role="tablist" aria-label="班ごとの行程">` +
    tracks.map((track) =>
      `<button class="pe-track-tab" type="button" role="tab" aria-selected="${track.key === selected?.key}"` +
      ` data-act="track" data-day="${index}" data-track="${escapeHtml(track.key)}">` +
      `${icon("users")}<span>${escapeHtml(editTrackLabel(track))}</span></button>`,
    ).join("") +
    `</div>` +
    `<p class="pe-track-note">「全員」の予定はどの班にも表示されます。ここで追加した予定は選択中の班のものになります。</p>`
  );
}

function quickAdd(_day: Day, index: number): string {
  const btn = (kind: ItemKind): string =>
    `<button class="pe-q" type="button" data-act="add" data-kind="${kind}" data-day="${index}">${icon(KINDS[kind].icon)}${KINDS[kind].label}を追加</button>`;
  const stayBtn = stayCovering(index)
    ? ""
    : `<button class="pe-q" type="button" data-act="add" data-kind="stay" data-day="${index}">${icon("buildingOffice2")}宿泊を設定</button>`;
  return (
    `<div class="pe-quick">` +
    btn("sight") + btn("food") + btn("move") + stayBtn + btn("todo") + btn("form") +
    `</div>`
  );
}

function renderDayStrip(): void {
  const nights = model.days.reduce((n, d) => n + (d.stay ? Math.max(1, d.stay.nights) : 0), 0);
  const cities = model.cities.length;
  tripSummaryEl.textContent = model.days.length
    ? ` ・ ${model.days.length}日間${nights ? ` ・ ${nights}泊` : ""}${cities ? ` ・ ${cities}都市` : ""}`
    : "";
  if (model.days.length < 2) { dayStripEl.innerHTML = ""; return; }
  dayStripEl.innerHTML = model.days
    .map((day, i) => {
      const d = parseISO(day.date);
      return `<button class="pe-daychip" type="button" data-jump="${i}"><b>Day ${i + 1}</b><span>${d ? `${d.getMonth() + 1}/${d.getDate()}` : ""}</span></button>`;
    })
    .join("");
}

function renderDays(): void {
  updateSteps();
  updateCalsync();
  renderDayStrip();
  dayCountEl.textContent = model.days.length ? `全${model.days.length}日` : "";
  if (!model.days.length) {
    daysEl.innerHTML =
      `<div class="pe-empty-cta"><b>期間を選択してください</b>` +
      `<span>旅行期間を設定すると、日ごとの予定欄が表示されます。</span></div>`;
    return;
  }
  daysEl.innerHTML = model.days
    .map((day, index) => {
      // 班タブで絞っているときは、全員の予定＋選択中の班の予定だけを出す
      const track = selectedEditTrack(day);
      const everyone = track ? everyoneIds(day.items.map((it) => it.members), presentIdsOnDate(day.date)) : [];
      const visible = track ? day.items.filter((it) => isItemInTrack(it.members, track, everyone)) : day.items;
      renderingWithTrack = Boolean(track);
      const items = visible.map(timelineNode).join("");
      renderingWithTrack = false;
      const empty = visible.length ? "" : `<p class="pe-day-empty">予定はまだありません。下のボタンから追加できます。</p>`;
      // 前夜の宿を朝に出発するときだけ「前泊から出発」を出す（連泊中は出さない）
      const coverPrev = index > 0 ? stayCovering(index - 1) : null;
      const coverToday = stayCovering(index);
      const leftHotel = coverPrev && (!coverToday || coverToday.stay.id !== coverPrev.stay.id);
      const startBanner = leftHotel && coverPrev.stay.title
        ? `<div class="pe-start"><span class="pe-start-ic">${icon("buildingOffice2")}</span>` +
          `<div class="pe-start-main"><b>前日の宿泊先</b><br><span>${escapeHtml(coverPrev.stay.title)}</span></div></div>`
        : "";
      // 都市名は各日の見出し（.pe-day-route）に出ているので、
      // 以前ここにあった都市バンドは二重表示になるため外した。
      return (
        `<article class="pe-day" data-day="${index}">` +
        dayHeader(day, index) +
        `<div class="pe-day-body">` +
        startBanner +
        dayTrackTabsHtml(day, index) +
        `<div class="pe-timeline">${items}</div>` +
        empty +
        stayBand(index) +
        quickAdd(day, index) +
        `</div>` +
        `</article>`
      );
    })
    .join("");
  initSortables();
}

// ドラッグ並べ替え（日内＋日跨ぎ）。SortableJS。
let sortables: Sortable[] = [];
function initSortables(): void {
  sortables.forEach((s) => s.destroy());
  sortables = [];
  daysEl.querySelectorAll<HTMLElement>(".pe-timeline").forEach((tl) => {
    sortables.push(
      Sortable.create(tl, {
        group: "pe-items",
        handle: ".pe-grip",
        draggable: ".pe-node",
        animation: 150,
        ghostClass: "pe-drag-ghost",
        chosenClass: "pe-drag-chosen",
        onEnd: () => {
          syncTimelineOrder();
          state.openItemId = null;
          markDirty();
          window.setTimeout(() => { renderDays(); refreshMap(false); }, 0);
        },
      }),
    );
  });
}

// DOM の並びからモデルの items を再構築（日跨ぎ移動も反映）
function syncTimelineOrder(): void {
  const all = new Map<number, Item>();
  model.days.forEach((d) => d.items.forEach((it) => all.set(it.id, it)));
  // 班タブで非表示の予定は DOM に存在しない。消さずに元の位置へ差し戻す。
  const domIds = new Map<number, number[]>();
  const seen = new Set<number>();
  daysEl.querySelectorAll<HTMLElement>("article[data-day]").forEach((article) => {
    const di = Number(article.dataset.day);
    const ids = Array.from(article.querySelectorAll<HTMLElement>(".pe-timeline > .pe-node")).map((n) => Number(n.dataset.node));
    domIds.set(di, ids);
    ids.forEach((id) => seen.add(id));
  });
  model.days.forEach((day, di) => {
    if (!domIds.has(di)) return;
    const ordered = (domIds.get(di) || []).map((id) => all.get(id)).filter((x): x is Item => Boolean(x));
    const hidden = day.items.map((item, index) => ({ item, index })).filter(({ item }) => !seen.has(item.id));
    for (const { item, index } of hidden) ordered.splice(Math.min(index, ordered.length), 0, item);
    day.items = ordered;
  });
}

// 入力時に行サマリ・日ヘッダだけを更新（全再描画せずフォーカス維持）
function refreshNode(item: Item): void {
  const node = daysEl.querySelector<HTMLElement>(`[data-node="${item.id}"]`);
  if (!node) return;
  if (item.kind === "stay") {
    const main = node.querySelector<HTMLElement>(".pe-stay-main");
    if (main) {
      const title = item.title || "ホテル名未入力";
      const meta = [item.time ? `IN ${item.time}` : "", item.nights > 1 ? `${item.nights}泊` : "", item.place].filter(Boolean).join(" ・ ");
      main.innerHTML = `<b class="${item.title ? "" : "is-empty"}">${escapeHtml(title)}</b><span>${escapeHtml(meta || "この日の宿泊先")}</span>`;
    }
  } else {
    const row = node.querySelector<HTMLElement>(".pe-row");
    if (row) row.innerHTML = rowControls(item);
  }
}

function refreshDayHeader(index: number): void {
  const article = daysEl.querySelector<HTMLElement>(`article[data-day="${index}"]`);
  const day = model.days[index];
  if (!article || !day) return;
  const head = article.querySelector(".pe-day-head");
  if (head) head.outerHTML = dayHeader(day, index);
}

function geoAppliedMessage(label: string): string {
  const clean = label.trim();
  return clean
    ? `設定先: ${clean}。違う場合は再検索、または地図で指定し直してください。`
    : "設定先: 住所未確認。違う場合は再検索、または地図で指定し直してください。";
}

function formatLatLng(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

async function onMapClick(latlng: L.LatLng): Promise<void> {
  if (state.armedCity !== null) { void applyCityPin(state.armedCity, latlng.lat, latlng.lng); return; }
  if (!state.armed) return;
  const itemId = state.armed.itemId;
  const target = state.armed.target;
  const found = findItem(itemId);
  if (!found) return;
  const lat = latlng.lat;
  const lng = latlng.lng;
  const [latKey, lngKey] = latLngKeys(target);
  found.item[latKey] = lat.toFixed(6);
  found.item[lngKey] = lng.toFixed(6);
  if (target === "from" || target === "to") {
    maybeDefaultMoveTransport(found.item, found.day, "", target);
    syncTransportSelect(found.item);
  }
  setGeoStatus(itemId, target, "設定先の住所を確認中…", "ok");
  disarm();
  markDirty();
  refreshMap(false);
  try {
    const label = await reverseLocation(lat, lng, MAPBOX_TOKEN);
    setGeoStatus(itemId, target, geoAppliedMessage(label || formatLatLng(lat, lng)), "ok");
  } catch {
    setGeoStatus(itemId, target, geoAppliedMessage(formatLatLng(lat, lng)), "ok");
  }
}

function disarm(): void {
  state.armed = null;
  state.armedCity = null;
  mapHintEl.textContent = "";
  mapEl.style.cursor = "";
  daysEl.querySelectorAll(".pe-mini.is-armed").forEach((b) => b.classList.remove("is-armed"));
  clearCandidates();
}

function arm(itemId: number, target: GeoTarget, button: HTMLElement): void {
  if (state.armed && state.armed.itemId === itemId && state.armed.target === target) { disarm(); return; }
  disarm();
  state.armed = { itemId, target };
  mapHintEl.textContent = "地図をクリックして位置を指定";
  mapEl.style.cursor = "crosshair";
  button.classList.add("is-armed");
  // 地図が閉じていると指定しようがないので開く。
  // スマホでは地図がボトムシートなので、開けばそのまま操作できる。
  if (root?.classList.contains("map-collapsed")) setMapCollapsed(false);
  root?.querySelector(".pe-mapwrap")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/**
 * 訪問地の位置を地図のクリックで決める待受に入る。
 * 名前で見つからない土地でも、ピンさえ置けば登録できるようにするため。
 */
function armCity(cityId: number, button: HTMLElement): void {
  if (state.armedCity === cityId) { disarm(); return; }
  disarm();
  state.armedCity = cityId;
  mapHintEl.textContent = "地図をクリックすると、その場所の都市名で登録します";
  mapEl.style.cursor = "crosshair";
  button.classList.add("is-armed");
  if (root?.classList.contains("map-collapsed")) setMapCollapsed(false);
  root?.querySelector(".pe-mapwrap")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** 地図で置いたピンから訪問地を確定する。 */
async function applyCityPin(cityId: number, lat: number, lng: number): Promise<void> {
  const city = model.cities.find((c) => c.id === cityId);
  if (!city) return;
  city.lat = lat.toFixed(6);
  city.lng = lng.toFixed(6);
  disarm();
  markDirty();
  renderCities();
  refreshMap(false);
  const notice = citiesEl.querySelector<HTMLElement>(`[data-city-nogeo="${cityId}"]`);
  if (notice) notice.textContent = "この地点の地名を確認中…";
  try {
    const name = await reverseCityName(lat, lng);
    const current = model.cities.find((c) => c.id === cityId);
    if (!current) return;
    if (name) current.name = name;
    markDirty();
    renderCities();
    refreshMap(false);
    toast(name ? `「${name}」で登録しました` : "位置を登録しました（地名は取得できませんでした）");
  } catch {
    toast("位置は登録しましたが、地名を取得できませんでした");
  }
}

// ---- ジオコーディング状態表示 -------------------------------------------

function setGeoStatus(itemId: number, target: GeoTarget, text: string, kind?: "ok" | "warn"): void {
  const el = daysEl.querySelector<HTMLElement>(`[data-geo="${itemId}-${target}"]`);
  if (!el) return;
  const mark = kind === "ok" ? icon("checkCircle") : kind === "warn" ? icon("exclamationTriangle") : "";
  el.innerHTML = mark + "<span>" + escapeHtml(text) + "</span>";
  el.className = "pe-geo-status" + (kind ? " is-" + kind : "");
}

function setPlaceLoading(itemId: number, target: GeoTarget, loading: boolean): void {
  const field = daysEl.querySelector<HTMLElement>(`[data-place-field="${itemId}-${target}"]`);
  if (!field) return;
  field.classList.toggle("is-loading", loading);
  if (loading) field.setAttribute("aria-busy", "true");
  else field.removeAttribute("aria-busy");
}

async function runGeocode(
  itemId: number,
  target: GeoTarget,
  options: { autoApplySingle?: boolean; quiet?: boolean; automatic?: boolean } = {},
): Promise<void> {
  const autoApplySingle = options.autoApplySingle === true;
  const found = findItem(itemId);
  if (!found) return;
  const item = found.item;
  const query = geoQueryForItem(item, target);
  const context = geocodeContextForDay(found.day, item, target);
  const key = `${itemId}-${target}`;
  const resultsEl = daysEl.querySelector<HTMLElement>(`[data-geores="${itemId}-${target}"]`);
  if (!query) { if (!options.quiet) setGeoStatus(itemId, target, "場所名を入力してください", "warn"); return; }
  const requestId = (geoRequestSeq.get(key) || 0) + 1;
  geoRequestSeq.set(key, requestId);
  const isCurrent = (): boolean => geoRequestSeq.get(key) === requestId;
  setPlaceLoading(itemId, target, true);
  setGeoStatus(itemId, target, context?.cityName ? `${context.cityName}を優先して検索中…` : "検索中…");
  clearCandidates();
  if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  try {
    const results = await geocodeSearch(query, context, Boolean(options.automatic));
    if (!isCurrent()) return;
    if (!results.length) {
      const area = context?.requireNearby && context.cityName ? `${context.cityName}周辺で` : "";
      setGeoStatus(itemId, target, `${area}見つかりませんでした。ホテル名や英字表記を変えて再検索を`, "warn");
      return;
    }
    if (results.length === 1 && autoApplySingle) { applyGeo(itemId, target, results[0]); return; }
    geoCache.set(`${itemId}-${target}`, results);
    showCandidates(itemId, target, results);
    if (resultsEl) {
      resultsEl.innerHTML = results
        .map((r, i) => `<button type="button" data-act="geo-pick" data-item="${itemId}" data-target="${target}" data-idx="${i}"><b>候補 ${i + 1}</b><small>${escapeHtml(r.label)}</small></button>`)
        .join("") + `<small class="pe-geo-attribution">${escapeHtml(geocodingAttribution(results))}</small>`;
      resultsEl.hidden = false;
      setGeoStatus(itemId, target, "地図のピン、または下の候補から選んでください");
    }
  } catch (e) {
    if (!isCurrent()) return;
    setGeoStatus(itemId, target, e instanceof Error ? e.message : "検索に失敗しました", "warn");
  } finally {
    if (isCurrent()) setPlaceLoading(itemId, target, false);
  }
}

const geoCache = new Map<string, GeoResult[]>();
const geoSuggestTimers = new Map<number, number>();
const geoRequestSeq = new Map<string, number>();

function invalidateGeoRequest(itemId: number, target: GeoTarget): void {
  const key = `${itemId}-${target}`;
  geoRequestSeq.set(key, (geoRequestSeq.get(key) || 0) + 1);
  setPlaceLoading(itemId, target, false);
}

function clearGeoResults(itemId: number, target: GeoTarget): void {
  invalidateGeoRequest(itemId, target);
  const resultsEl = daysEl.querySelector<HTMLElement>(`[data-geores="${itemId}-${target}"]`);
  if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  geoCache.delete(`${itemId}-${target}`);
}

function scheduleNamePlaceSuggest(item: Item): void {
  const existing = geoSuggestTimers.get(item.id);
  if (existing) window.clearTimeout(existing);
  invalidateGeoRequest(item.id, "place");
  if (!automaticGeocodingAvailable(MAPBOX_TOKEN) || !["sight", "stay"].includes(item.kind) || item.place.trim() || item.title.trim().length < 2) {
    clearGeoResults(item.id, "place");
    return;
  }
  const timer = window.setTimeout(() => {
    geoSuggestTimers.delete(item.id);
    void runGeocode(item.id, "place", { autoApplySingle: false, quiet: true, automatic: true });
  }, 650);
  geoSuggestTimers.set(item.id, timer);
}

function applyGeo(itemId: number, target: GeoTarget, r: GeoResult): void {
  const found = findItem(itemId);
  if (!found) return;
  const [latKey, lngKey] = latLngKeys(target);
  found.item[latKey] = String(r.lat);
  found.item[lngKey] = String(r.lng);
  if (target === "from" || target === "to") {
    maybeDefaultMoveTransport(found.item, found.day, r.label, target);
    syncTransportSelect(found.item);
  }
  if (target === "place") {
    found.item.mapQuery = r.label;
    if (!found.item.place.trim()) found.item.place = conciseGeoLabel(r.label);
    const placeInput = daysEl.querySelector<HTMLInputElement>(`[data-field="place"][data-item="${itemId}"]`);
    if (placeInput) placeInput.value = found.item.place;
  }
  const resultsEl = daysEl.querySelector<HTMLElement>(`[data-geores="${itemId}-${target}"]`);
  if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  clearCandidates();
  mapHintEl.textContent = "";
  setGeoStatus(itemId, target, geoAppliedMessage(r.label || formatLatLng(r.lat, r.lng)), "ok");
  markDirty();
  refreshNode(found.item);
  refreshDayHeader(model.days.indexOf(found.day));
  refreshMap(true);
}

// ---- イベント委譲 -------------------------------------------------------

daysEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest("[data-grip]")) return; // ドラッグハンドルのクリックは無視
  const actEl = target.closest<HTMLElement>("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  const itemId = Number(actEl.dataset.item || actEl.closest<HTMLElement>("[data-node]")?.dataset.node || 0);
  const dayIndex = Number(actEl.dataset.day || 0);

  if (act === "toggle") {
    state.openItemId = state.openItemId === itemId ? null : itemId;
    disarm();
    renderDays();
    focusOpenItem();
    return;
  }
  if (act === "close") { state.openItemId = null; disarm(); renderDays(); return; }
  if (act === "remove") {
    const found = findItem(itemId);
    if (found) {
      if (found.item.kind === "stay") found.day.stay = null;
      else found.day.items = found.day.items.filter((x) => x.id !== itemId);
      markDirty(); renderDays(); refreshMap(false);
    }
    return;
  }
  if (act === "track") {
    const day = model.days[dayIndex];
    if (day) {
      editTrackChoice.set(day.date, actEl.dataset.track || "");
      renderDays();
      refreshMap(false);
    }
    return;
  }
  if (act === "add") {
    const kind = (actEl.dataset.kind || "sight") as ItemKind;
    const day = model.days[dayIndex];
    if (!day) return;
    const it = newItem(kind);
    maybeDefaultMoveTransport(it, day, "", undefined, true);
    // 班タブを選んでいる日は、追加した予定をその班のものにする
    // （全員の予定にしたければ、予定を開いて対象メンバーを「全員」に戻せる）
    const track = selectedEditTrack(day);
    if (track && kind !== "stay") it.members = [...track.memberIds];
    if (kind === "stay") day.stay = it;
    else day.items.push(it);
    state.openItemId = it.id;
    markDirty(); renderDays(); refreshMap(false); focusOpenItem();
    return;
  }
  if (act === "members-all") {
    const found = findItem(itemId);
    if (found && found.item.members.length) {
      found.item.members = [];
      markDirty(); renderDays();
    }
    return;
  }
  if (act === "member-toggle") {
    const found = findItem(itemId);
    const uid = actEl.dataset.member || "";
    if (found && uid) {
      const set = new Set(found.item.members);
      if (set.has(uid)) set.delete(uid);
      else set.add(uid);
      // 全員を選んだ状態は「全員（空）」と同じ意味なので空へ正規化する
      const ids = model.memberIds.filter((id) => id && db.nameOf(id));
      found.item.members = ids.length && ids.every((id) => set.has(id)) ? [] : [...set];
      markDirty(); renderDays();
    }
    return;
  }
  if (act === "copy-prev") {
    const day = model.days[dayIndex];
    const prev = model.days[dayIndex - 1];
    if (!day || !prev) return;
    day.area = day.area || prev.area;
    prev.items.forEach((it) => day.items.push(newItem(it.kind, it)));
    if (prev.stay && !day.stay) day.stay = newItem("stay", prev.stay);
    markDirty(); renderDays(); refreshMap(true);
    return;
  }
  if (act === "sort-time") {
    const day = model.days[dayIndex];
    if (day) {
      day.items = day.items
        .map((it, i) => ({ it, i }))
        .sort((a, b) => timeOrder(a.it.time) - timeOrder(b.it.time) || a.i - b.i)
        .map((x) => x.it);
      markDirty(); renderDays(); refreshMap(false);
    }
    return;
  }
  if (act === "geo") { void runGeocode(itemId, (actEl.dataset.target || "place") as GeoTarget); return; }
  if (act === "geo-arm") { arm(itemId, (actEl.dataset.target || "place") as GeoTarget, actEl); return; }
  if (act === "geo-pick") {
    const key = `${itemId}-${actEl.dataset.target}`;
    const list = geoCache.get(key);
    const r = list && list[Number(actEl.dataset.idx || 0)];
    if (r) applyGeo(itemId, (actEl.dataset.target || "place") as GeoTarget, r);
    return;
  }
});

daysEl.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement) && !(target instanceof HTMLSelectElement)) return;

  // 日の拠点エリア
  const areaIdx = target.getAttribute("data-area");
  if (areaIdx !== null) {
    const day = model.days[Number(areaIdx)];
    if (day) { day.area = target.value; refreshDayHeader(Number(areaIdx)); markDirty(); }
    return;
  }

  const fieldName = target.getAttribute("data-field");
  const itemId = Number(target.getAttribute("data-item") || 0);
  if (!fieldName || !itemId) return;
  const found = findItem(itemId);
  if (!found) return;

  // 泊数（数値・連泊範囲が変わるので全再描画）
  if (fieldName === "nights") {
    found.item.nights = Math.max(1, Math.min(stayNightLimits(found.item).tripMax, Number(target.value) || 1));
    markDirty();
    renderDays();
    refreshMap(false);
    return;
  }

  const field = fieldName as ItemStrKey;
  const previousValue = found.item[field];
  found.item[field] = target.value;

  // 入力名と座標は一組として扱う。名前だけ変わったのに以前の座標が残る状態を作らない。
  if (previousValue !== target.value && (field === "place" || field === "mapQuery")) {
    clearItemCoords(found.item, "place");
    if (field === "place") found.item.mapQuery = "";
    autoCoords(found.item, "place");
  }
  if (previousValue !== target.value && field === "from") {
    clearGeoResults(found.item.id, "from");
    clearItemCoords(found.item, "from");
    autoCoords(found.item, "from");
  }
  if (previousValue !== target.value && field === "to") {
    clearGeoResults(found.item.id, "to");
    clearItemCoords(found.item, "to");
    autoCoords(found.item, "to");
  }
  if (field === "from" || field === "to") {
    maybeDefaultMoveTransport(found.item, found.day, "", field);
    syncTransportSelect(found.item);
  }
  if (field === "title") scheduleNamePlaceSuggest(found.item);
  if (field === "place") {
    const timer = geoSuggestTimers.get(found.item.id);
    if (timer) window.clearTimeout(timer);
    geoSuggestTimers.delete(found.item.id);
    clearGeoResults(found.item.id, "place");
  }

  refreshNode(found.item);
  const di = model.days.indexOf(found.day);
  if (found.item.kind === "stay" || field === "place" || field === "from" || field === "to") refreshDayHeader(di);
  markDirty();
  scheduleMapRefresh();
});

// ---- 基本情報の入力バインド ---------------------------------------------

root.querySelectorAll<HTMLInputElement>("[data-f]").forEach((input) => {
  input.addEventListener("input", () => {
    const key = input.dataset.f;
    if (key === "title" || key === "members" || key === "note") {
      model[key] = input.value;
    }
    if (key === "title") titleEcho.textContent = input.value || "新しい計画";
    markDirty();
  });
});

// ---- サムネ画像（任意・未設定なら自動/デフォルト） ----------------------
// 選んだ画像は canvas で小容量 WebP に変換し、上限を超える画像は保存しない。


const MAX_COVER_DATA_URL_LENGTH = 300_000;

/** 画像ファイルを縮小し、API/DBの契約内に収まる WebP data URL に変換する。 */
function fileToWebpDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type || "")) {
      reject(new Error("画像ファイルを選択してください"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = (): void => reject(new Error("画像を読み込めませんでした"));
    reader.onload = (): void => {
      const img = new Image();
      img.onerror = (): void => reject(new Error("画像を処理できませんでした"));
      img.onload = (): void => {
        const nw = img.naturalWidth || img.width;
        const nh = img.naturalHeight || img.height;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas を初期化できませんでした"));
          return;
        }
        const attempts = [
          { maxSize: 720, quality: 0.78 },
          { maxSize: 560, quality: 0.70 },
          { maxSize: 420, quality: 0.64 },
        ];
        for (const attempt of attempts) {
          const scale = Math.min(1, attempt.maxSize / Math.max(nw, nh));
          canvas.width = Math.max(1, Math.round(nw * scale));
          canvas.height = Math.max(1, Math.round(nh * scale));
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/webp", attempt.quality);
          if (dataUrl.length <= MAX_COVER_DATA_URL_LENGTH) {
            resolve(dataUrl);
            return;
          }
        }
        reject(new Error("画像を十分に小さくできませんでした。別の画像を選んでください"));
      };
      img.src = String(reader.result || "");
    };
    reader.readAsDataURL(file);
  });
}

/** プレビューに使う画像（手動設定があればそれ、無ければ目的地から自動/デフォルト）。 */
function previewCoverSrc(): string {
  return planCoverThumbnail({
    slug: model.slug,
    route: model.cities.map((c) => c.name).filter(Boolean).join("、"),
    title: model.title,
    cover: model.cover,
  });
}

function updateCoverPreview(): void {
  coverPreview.style.backgroundImage = `url("${previewCoverSrc()}")`;
  coverPreview.classList.toggle("is-custom", Boolean(model.cover));
  coverClearBtn.hidden = !model.cover;
}

coverInput.addEventListener("change", () => {
  const file = coverInput.files && coverInput.files[0];
  coverInput.value = ""; // 同じファイルを再選択できるようにリセット
  if (!file) return;
  void fileToWebpDataUrl(file)
    .then((dataUrl) => {
      model.cover = dataUrl;
      updateCoverPreview();
      markDirty();
    })
    .catch((err) => {
      statusEl.textContent = errorMessage(err) || "画像を設定できませんでした";
      statusEl.className = "is-dirty";
    });
});

coverClearBtn.addEventListener("click", () => {
  if (!model.cover) return;
  model.cover = "";
  updateCoverPreview();
  markDirty();
});

// ---- メンバー（チップ／友達候補／招待リンク） --------------------------


function hasMemberAccount(): boolean {
  return Boolean(currentAccount());
}

function memberArray(): string[] { return splitNames(model.members); }
function syncMemberNames(): void {
  model.members = [
    ...model.memberIds.map((id) => db.nameOf(id)).filter(Boolean),
    ...model.pendingMembers.map((member) => member.name),
  ].join("、");
}
function setMembers(ids: string[]): void {
  model.memberIds = [...new Set(ids.filter(Boolean))];
  syncMemberNames();
  markDirty();
  updateMemberVisibility();
  renderMembers();
  renderMemberSelect();
}
function addMember(userId: string): void {
  if (!userId) return;
  setMembers([...model.memberIds, userId]);
}
function removeMember(userId: string): void {
  setMembers(model.memberIds.filter((id) => id !== userId));
}
function addPendingMember(name: string): void {
  const displayName = name.trim().slice(0, 64);
  if (!displayName) return;
  model.pendingMembers.push({ key: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: displayName });
  syncMemberNames();
  markDirty();
  renderMembers();
}
function removePendingMember(key: string): void {
  model.pendingMembers = model.pendingMembers.filter((member) => member.key !== key);
  syncMemberNames();
  markDirty();
  renderMembers();
}

async function persistPendingMembers(): Promise<void> {
  if (!model.pendingMembers.length || !state.slug) return;
  const planId = TripPlans.planIdOf(state.slug);
  if (!planId) throw new Error("旅行を保存してから未登録メンバーを追加してください");
  model.memberIds = [...new Set([
    ...model.memberIds,
    ...db.members()
      .filter((member) => member.plan_id === planId && member.status === "active")
      .map((member) => member.user_id),
  ])];
  const pending = [...model.pendingMembers];
  try {
    for (const entry of pending) {
      const created = await db.createPlaceholderMember(planId, entry.name);
      model.memberIds.push(created.user.id);
      model.pendingMembers = model.pendingMembers.filter((member) => member.key !== entry.key);
    }
  } finally {
    // 途中の1件で失敗しても、既に作成済みの人を「保存前」と表示し続けない。
    model.memberIds = [...new Set(model.memberIds)];
    syncMemberNames();
    renderMembers();
    renderMemberSelect();
  }
}

setPersistHooks({ persistPendingMembers });

function renderMembers(): void {
  const account = currentAccount();
  const me = account?.name || "";
  const arr = memberArray();
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const stored = meta ? db.planBySlug(meta.slug) : null;
  const ownerId = stored?.owner_user_id || account?.id || "";
  const memberAccounts = model.memberIds.map((id) => ({ id, name: db.nameOf(id) })).filter((member) => member.name);
  const savedMembers = memberAccounts.length
    ? memberAccounts.map((member) => ({ ...member, pendingKey: "" }))
    : model.pendingMembers.length
      ? []
      : arr.map((name) => ({ id: listFriends().find((friend) => friend.name === name)?.id || "", name, pendingKey: "" }));
  const displayMembers = savedMembers.concat(
    model.pendingMembers.map((member) => ({ id: "", name: member.name, pendingKey: member.key })),
  );
  const planId = stored?.id || "";
  const memberChips = displayMembers
    .map((member) => {
      const self = account?.id ? member.id === account.id : Boolean(me) && member.name === me;
      const placeholder = Boolean(member.id && planId && db.isPlaceholderMember(planId, member.id));
      const claimedPlaceholder = member.id && planId ? db.claimedPlaceholderFor(planId, member.id) : undefined;
      return (
        `<span class="pe-chip-m${self ? " is-self" : ""}">` +
        `<span>${escapeHtml(member.name)}</span>` +
        (self ? `<span class="pe-chip-self">自分</span>` : "") +
        (member.id === ownerId ? `<span class="pe-chip-self">Owner</span>` : "") +
        (member.pendingKey ? `<span class="pe-chip-pending">保存前</span>` : "") +
        (placeholder ? `<span class="pe-chip-pending">未登録</span>` : "") +
        (claimedPlaceholder ? `<span class="pe-chip-pending">本人紐付済み</span>` : "") +
        (meta && canManagePlan(meta) && member.id && !placeholder && !self && member.id !== ownerId
          ? `<button class="pe-chip-ic" type="button" data-transfer-owner="${escapeHtml(member.id)}" data-transfer-name="${escapeHtml(member.name)}" title="所有権を移譲" aria-label="${escapeHtml(member.name)}へ所有権を移譲">${icon("arrowsRightLeft")}</button>`
          : "") +
        (!account || self || member.pendingKey
          ? ""
          : `<button class="pe-chip-ic invite" type="button" data-invite="${escapeHtml(member.name)}" data-invite-user="${escapeHtml(member.id)}" title="招待リンクを送る" aria-label="${escapeHtml(member.name)}を招待">${icon("paperAirplane")}</button>`) +
        (member.pendingKey
          ? `<button class="pe-chip-ic del" type="button" data-rm-pending="${escapeHtml(member.pendingKey)}" title="削除" aria-label="${escapeHtml(member.name)}を削除">${icon("xMark")}</button>`
          : member.id && member.id !== ownerId
          ? `<button class="pe-chip-ic del" type="button" data-rm="${escapeHtml(member.id)}" title="削除" aria-label="${escapeHtml(member.name)}を削除">${icon("xMark")}</button>`
          : "") +
        (claimedPlaceholder && meta && canManagePlan(meta) && member.id !== ownerId
          ? `<button class="pe-chip-ic del" type="button" data-unclaim="${escapeHtml(claimedPlaceholder.user_id)}" title="本人紐付けを取り消す" aria-label="${escapeHtml(member.name)}の本人紐付けを取り消す">${icon("arrowPath")}</button>`
          : "") +
        `</span>`
      );
    })
    .join("");
  membersMount.innerHTML = memberChips + memberPeriodsHtml();
  void renderActiveInvites();
}

let inviteListLoading = false;
async function renderActiveInvites(): Promise<void> {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) {
    activeInvitesMount.innerHTML = "";
    return;
  }
  if (inviteListLoading) return;
  inviteListLoading = true;
  try {
    const pending = (await db.listInvites(meta.id)).filter((invite) => invite.status === "pending");
    activeInvitesMount.innerHTML = pending.length
      ? `<p class="pe-member-hint">有効な招待 ${pending.length}件</p>` + pending.map((invite) =>
        `<span class="pe-chip-m"><span>${escapeHtml(invite.invited_name || "共通招待")}</span>` +
        `<span class="pe-chip-pending">${invite.role === "viewer" ? "閲覧" : "編集"}</span>` +
        `<button class="pe-chip-ic del" type="button" data-revoke-invite="${escapeHtml(invite.id)}" aria-label="招待を取り消す">${icon("xMark")}</button></span>`,
      ).join("")
      : "";
  } catch {
    activeInvitesMount.innerHTML = `<p class="pe-member-hint">有効な招待を取得できませんでした</p>`;
  } finally {
    inviteListLoading = false;
  }
}

activeInvitesMount.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-revoke-invite]") : null;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!button || !meta?.id) return;
  button.setAttribute("disabled", "true");
  void db.revokeInvite(meta.id, button.dataset.revokeInvite || "")
    .then(() => renderActiveInvites())
    .catch((error) => { toast(errorMessage(error) || "招待を取り消せませんでした"); button.removeAttribute("disabled"); });
});

/**
 * メンバーごとの参加期間。デフォルトは全員が全日程参加（内部では null 端＝無制限）。
 * 全員が全日程のうちは1行のサマリに畳み、「途中合流/離脱を設定」で展開する。
 * 保存済み計画で、旅行期間が決まっていて、管理者のときだけ出す。
 */
let memberPeriodsOpen = false;

function memberPeriodLabel(dates: { from: string | null; to: string | null }): string {
  if (!dates.from && !dates.to) return "全日程";
  if (dates.from && dates.to) return `${mdLabel(dates.from)}〜${mdLabel(dates.to)}`;
  return dates.from ? `${mdLabel(dates.from)} 合流` : `${mdLabel(dates.to || "")} 離脱`;
}

/** 旅行期間の中でどこに在籍しているかを示すミニバー。期間がパースできないときは出さない。 */
function memberPeriodBar(dates: { from: string | null; to: string | null }, start: string, end: string): string {
  const startD = parseISO(start);
  const endD = parseISO(end);
  if (!startD || !endD) return "";
  const total = Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1;
  if (total <= 0) return "";
  const dayIndex = (iso: string | null, fallback: number): number => {
    const d = iso ? parseISO(iso) : null;
    if (!d) return fallback;
    return Math.min(Math.max(Math.round((d.getTime() - startD.getTime()) / 86400000), 0), total - 1);
  };
  let fromIdx = dayIndex(dates.from, 0);
  let toIdx = dayIndex(dates.to, total - 1);
  if (toIdx < fromIdx) { fromIdx = 0; toIdx = total - 1; }
  const left = (fromIdx / total) * 100;
  const width = ((toIdx - fromIdx + 1) / total) * 100;
  return `<span class="pe-mperiod-bar" aria-hidden="true"><span style="left:${left}%;width:${width}%"></span></span>`;
}

function memberPeriodsHtml(): string {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) return "";
  if (!model.startDate || !model.endDate) return "";
  const ids = model.memberIds.filter((id) => id && db.nameOf(id));
  if (!ids.length) return "";
  const start = model.startDate;
  const end = model.endDate;
  const isFull = (id: string): boolean => {
    const dates = model.memberDates[id];
    return !dates || (!dates.from && !dates.to);
  };
  const allFull = ids.every(isFull);
  if (allFull && !memberPeriodsOpen) {
    return (
      `<div class="pe-mperiods is-collapsed">` +
      `<p class="pe-mperiods-head">${icon("calendarDays")}参加期間</p>` +
      `<div class="pe-mperiods-summary">` +
      `<span>全員が全日程（${mdLabel(start)}〜${mdLabel(end)}）に参加</span>` +
      `<button class="pe-mperiods-toggle" type="button" data-mperiods-toggle>途中合流/離脱を設定</button>` +
      `</div>` +
      `</div>`
    );
  }
  const row = (id: string): string => {
    const dates = model.memberDates[id] || { from: null, to: null };
    const full = isFull(id);
    return (
      `<div class="pe-mperiod${full ? "" : " is-partial"}">` +
      `<span class="pe-mperiod-name">${escapeHtml(db.nameOf(id))}</span>` +
      memberPeriodBar(dates, start, end) +
      `<span class="pe-mperiod-badge${full ? " is-full" : ""}">${escapeHtml(memberPeriodLabel(dates))}</span>` +
      `<span class="pe-mperiod-fields">` +
      `<label class="pe-mperiod-field">合流<input type="date" data-member-from="${escapeHtml(id)}" value="${dates.from || start}" min="${start}" max="${end}"></label>` +
      `<label class="pe-mperiod-field">離脱<input type="date" data-member-to="${escapeHtml(id)}" value="${dates.to || end}" min="${start}" max="${end}"></label>` +
      (full
        ? ""
        : `<button class="pe-mperiod-reset" type="button" data-member-reset="${escapeHtml(id)}" title="全日程参加に戻す">全日程に戻す</button>`) +
      `</span>` +
      `</div>`
    );
  };
  return (
    `<div class="pe-mperiods">` +
    `<p class="pe-mperiods-head">${icon("calendarDays")}参加期間` +
    (allFull ? `<button class="pe-mperiods-toggle" type="button" data-mperiods-toggle>閉じる</button>` : "") +
    `</p>` +
    `<p class="pe-mperiods-desc">初期設定は全員が全日程参加です。途中合流/離脱する人だけ日付を変えてください。</p>` +
    ids.map(row).join("") +
    `<p class="pe-mperiods-note">その日の費用は「全員で等分」でも、在籍していた人だけで割ります。</p>` +
    `</div>`
  );
}

/** 現在の memberIds・役割・参加期間から、メンバー一覧をまるごと保存する。 */
function persistMemberDates(): void {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) return;
  const ownerId = db.planBySlug(meta.slug)?.owner_user_id || currentAccount()?.id || "";
  const checkpoint = db.mutationCheckpoint();
  db.replaceMembers(meta.id, model.memberIds.filter(Boolean).map((id) => {
    const current = db.members().find((member) => member.plan_id === meta.id && member.user_id === id);
    const dates = model.memberDates[id] || { from: null, to: null };
    return {
      user_id: id,
      role: id === ownerId ? "owner" : current?.role === "viewer" ? "viewer" : "editor",
      from_date: dates.from,
      to_date: dates.to,
    };
  }));
  // 投げっぱなしにせず、失敗したら画面へ返す（成功表示のまま消えるのを防ぐ）
  void db.flushMutations(checkpoint).catch((error) => {
    toast(errorMessage(error) || "参加期間を保存できませんでした");
  });
}

function memberCandidates(): { id: string; name: string }[] {
  const account = currentAccount();
  if (!account) return [];
  const excluded = new Set([account.id, ...model.memberIds]);
  return listFriends()
    .filter((friend) => friend.id && !excluded.has(friend.id))
    .map((friend) => ({ id: friend.id, name: (friend.name || friend.email).trim() }))
    .filter((friend) => friend.name)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"))
    .slice(0, 12);
}

function renderMemberSelect(): void {
  const candidates = memberCandidates();
  memberSelect.innerHTML =
    `<option value="">友達を選択</option>` +
    (candidates.length
      ? candidates.map((friend) => `<option value="${escapeHtml(friend.id)}">${escapeHtml(friend.name)}</option>`).join("")
      : `<option value="" disabled>追加できる友達がいません</option>`);
  memberSelect.value = "";
  memberSelect.disabled = !candidates.length;
  memberAddBtn.disabled = !candidates.length;
  memberHint.hidden = false;
}

function updateMemberVisibility(): void {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const enabled = hasMemberAccount() && (!meta || canManagePlan(meta));
  memberField.hidden = !enabled;
  memberField.classList.toggle("is-enabled", enabled);
}

function updateWorkspaceControlVisibility(): void {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const accountId = currentAccount()?.id || "";
  const memberEditor = !meta || Boolean(
    meta.id && accountId && db.members().some((member) =>
      member.plan_id === meta.id && member.user_id === accountId &&
      (member.role === "owner" || member.role === "editor") && member.status === "active"
    )
  );
  const candidateSection = root?.querySelector<HTMLElement>("[data-cand-section]");
  if (candidateSection) candidateSection.hidden = !memberEditor;
}

function refreshMemberField(): void {
  updateMemberVisibility();
  updateWorkspaceControlVisibility();
  renderMembers();
  renderMemberSelect();
}

// ログイン状態は別タブ（storage イベント）やマイページのドロワー（同一オリジンの
// iframeなので localStorage 変更は storage イベントとして親に届く）で変わることがある。
// このページ自身は読み込み時に1回しかログイン状態を見ないため、タブに戻ってきた
// タイミングでも再評価しないと「ログイン済みなのにメンバー欄が出ない」状態のまま残る。
window.addEventListener("storage", refreshMemberField);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshMemberField();
});

membersMount.addEventListener("click", (event) => {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const rm = t.closest<HTMLElement>("[data-rm]");
  if (rm) { removeMember(rm.dataset.rm || ""); return; }
  const unclaim = t.closest<HTMLElement>("[data-unclaim]");
  if (unclaim) {
    const meta = state.slug ? TripPlans.get(state.slug) : null;
    if (!meta?.id || !window.confirm("本人紐付けを取り消し、費用・精算・投票を元の未登録メンバーへ戻しますか？")) return;
    void db.undoPlaceholderClaim(meta.id, unclaim.dataset.unclaim || "")
      .then(() => { toast("本人紐付けを取り消しました"); location.reload(); })
      .catch((error) => toast(errorMessage(error) || "本人紐付けを取り消せませんでした"));
    return;
  }
  const pending = t.closest<HTMLElement>("[data-rm-pending]");
  if (pending) { removePendingMember(pending.dataset.rmPending || ""); return; }
  const transfer = t.closest<HTMLElement>("[data-transfer-owner]");
  if (transfer) {
    void transferOwnership(transfer.dataset.transferOwner || "", transfer.dataset.transferName || "");
    return;
  }
  const periodsToggle = t.closest<HTMLElement>("[data-mperiods-toggle]");
  if (periodsToggle) { memberPeriodsOpen = !memberPeriodsOpen; renderMembers(); return; }
  const periodReset = t.closest<HTMLElement>("[data-member-reset]");
  if (periodReset) {
    const id = periodReset.dataset.memberReset || "";
    if (id) {
      model.memberDates[id] = { from: null, to: null };
      persistMemberDates();
      renderMembers();
    }
    return;
  }
  const inv = t.closest<HTMLElement>("[data-invite]");
  if (inv) { void shareInvite(inv.dataset.invite || "", inv.dataset.inviteUser || ""); }
});

// 途中合流/離脱の日付入力。確定した時点で参加期間を保存する。
membersMount.addEventListener("change", (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const fromId = input.dataset.memberFrom;
  const toId = input.dataset.memberTo;
  const id = fromId || toId;
  if (!id) return;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) return;
  const current = model.memberDates[id] || { from: null, to: null };
  const value = input.value || null;
  const next = fromId ? { from: value, to: current.to } : { from: current.from, to: value };
  // 旅行の開始日/終了日と同じ（か外側）なら全日程扱いの null に正規化する。
  // null 端は無制限なので、あとから旅行期間を広げてもその人は全日程のまま追従する。
  if (next.from && model.startDate && next.from <= model.startDate) next.from = null;
  if (next.to && model.endDate && next.to >= model.endDate) next.to = null;
  // 合流が離脱より後なら矛盾。両方クリアして全日程に倒す（サーバ側も同様に無効化）。
  if (next.from && next.to && next.from > next.to) { next.from = null; next.to = null; }
  model.memberDates[id] = next;
  persistMemberDates();
  renderMembers();
});

async function transferOwnership(userId: string, name: string): Promise<void> {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const planId = meta?.id || (state.slug ? TripPlans.planIdOf(state.slug) : "");
  if (!meta || !planId || !userId || !canManagePlan(meta)) return;
  if (!window.confirm(`${name}さんへ所有権を移譲しますか？あなたは編集者になります。`)) return;
  try {
    await db.transferPlanOwnership(planId, userId);
    refreshMemberField();
    toast(`${name}さんへ所有権を移譲しました`);
  } catch (error) {
    toast(errorMessage(error) || "所有権を移譲できませんでした");
  }
}

function commitMemberSelect(): void {
  const v = memberSelect.value.trim();
  if (!v) return;
  addMember(v);
}
memberAddBtn.addEventListener("click", commitMemberSelect);
memberSelect.addEventListener("change", commitMemberSelect);
function commitMemberName(): void {
  const name = memberNameInput.value;
  if (!name.trim()) return;
  addPendingMember(name);
  memberNameInput.value = "";
  memberNameInput.focus();
}
memberNameAddBtn.addEventListener("click", commitMemberName);
memberNameInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  commitMemberName();
});


// ---- 行きたい候補（投票ボード） ----------------------------------------


function candId(): string {
  return "cand_" + state.seq++ + "_" + Math.random().toString(36).slice(2, 6);
}

/** 票数の多い順（同数は作成順）に並べる。 */
function sortedCandidates(): Candidate[] {
  return model.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.voteIds?.length ?? b.c.votes?.length ?? 0) - (a.c.voteIds?.length ?? a.c.votes?.length ?? 0) || a.i - b.i)
    .map((x) => x.c);
}

function candidateDayOptions(): string {
  return model.days
    .map((day, index) => {
      const dt = parseISO(day.date);
      const date = dt ? `${dt.getMonth() + 1}/${dt.getDate()}` : day.date;
      const city = cityForDate(day.date);
      const area = city?.name || day.area || "";
      const label = [`Day ${index + 1}`, date, area].filter(Boolean).join(" / ");
      return `<option value="${index}">${escapeHtml(label)}</option>`;
    })
    .join("");
}

function renderCandidates(): void {
  const me = getUser().name.trim();
  const meId = currentAccount()?.id || "";
  const list = sortedCandidates();
  candCountEl.textContent = list.length ? `${list.length}件` : "";
  if (!list.length) {
    candMount.innerHTML = "";
    return;
  }
  const canAdopt = model.days.length > 0;
  candMount.innerHTML = list
    .map((c) => {
      const voted = meId ? Boolean(c.voteIds?.includes(meId)) : Boolean(me) && (c.votes || []).includes(me);
      const n = c.voteIds?.length ?? (c.votes || []).length;
      const sub = [c.place, c.proposer ? `提案: ${c.proposer}` : ""].filter(Boolean).join(" ・ ");
      const adoptControls = canAdopt
        ? `<label class="pe-cand-day"><span>追加先</span><select data-cand-day="${escapeHtml(c.id)}">${candidateDayOptions()}</select></label>` +
          `<button class="pe-cand-act" type="button" data-cand-adopt="${escapeHtml(c.id)}">${icon("plus")}行程に追加</button>`
        : `<button class="pe-cand-act" type="button" data-cand-adopt="${escapeHtml(c.id)}" disabled title="先に日程を作ってください">${icon("plus")}行程に追加</button>`;
      return (
        `<div class="pe-cand-row${c.adopted ? " is-adopted" : ""}" data-cand="${escapeHtml(c.id)}">` +
        `<button class="pe-cand-vote${voted ? " is-voted" : ""}" type="button" data-cand-vote="${escapeHtml(c.id)}" aria-pressed="${voted}" title="行きたい">${icon("star")}<span>${n}</span></button>` +
        `<span class="pe-cand-body"><span class="pe-cand-title">${escapeHtml(c.title)}</span>${sub ? `<span class="pe-cand-sub">${escapeHtml(sub)}</span>` : ""}</span>` +
        (c.adopted
          ? `<span class="pe-cand-sub">追加済み</span>`
          : adoptControls) +
        `<button class="pe-cand-del" type="button" data-cand-del="${escapeHtml(c.id)}" aria-label="削除">${icon("xMark")}</button>` +
        `</div>`
      );
    })
    .join("");
}

function addCandidate(title: string): void {
  const t = title.trim();
  if (!t) return;
  const me = getUser().name.trim();
  const meId = currentAccount()?.id || "";
  model.candidates.push({
    id: candId(),
    title: t,
    votes: me ? [me] : [],
    voteIds: meId ? [meId] : [],
    proposer: me || undefined,
    proposerId: meId || undefined,
    createdAt: new Date().toISOString(),
  });
  markDirty();
  renderCandidates();
}

function toggleVote(id: string): void {
  const me = getUser().name.trim();
  const meId = currentAccount()?.id || "";
  if (!meId) {
    toast("投票するにはログインしてください");
    return;
  }
  const c = model.candidates.find((x) => x.id === id);
  if (!c) return;
  c.voteIds = c.voteIds || [];
  const idIndex = c.voteIds.indexOf(meId);
  if (idIndex >= 0) c.voteIds.splice(idIndex, 1);
  else c.voteIds.push(meId);
  // 表示用の名前配列も更新するが、保存には使用しない。
  c.votes = c.votes || [];
  const i = c.votes.indexOf(me);
  if (i >= 0) c.votes.splice(i, 1);
  else c.votes.push(me);
  markDirty();
  renderCandidates();
}

function adoptCandidate(id: string, dayIndex = 0): void {
  const c = model.candidates.find((x) => x.id === id);
  if (!c) return;
  if (!model.days.length) {
    toast("先に日程（期間）を作ってください");
    return;
  }
  const targetIndex = Math.max(0, Math.min(model.days.length - 1, dayIndex));
  const kind = normalizeKind(c.type);
  const it = newItem(kind, {
    title: c.title,
    place: c.place || "",
    note: c.note || "",
    lat: c.lat != null ? String(c.lat) : "",
    lng: c.lng != null ? String(c.lng) : "",
    mapQuery: c.place || c.title || "",
  });
  model.days[targetIndex].items.push(it);
  c.adopted = true;
  markDirty();
  renderCandidates();
  renderDays();
  refreshMap(false);
  toast(`Day ${targetIndex + 1} に追加しました。ドラッグで日や順番を調整できます`);
}

function removeCandidate(id: string): void {
  model.candidates = model.candidates.filter((x) => x.id !== id);
  markDirty();
  renderCandidates();
}

candMount.addEventListener("click", (event) => {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const vote = t.closest<HTMLElement>("[data-cand-vote]");
  if (vote) {
    toggleVote(vote.dataset.candVote || "");
    return;
  }
  const adopt = t.closest<HTMLElement>("[data-cand-adopt]");
  if (adopt) {
    const row = t.closest<HTMLElement>("[data-cand]");
    const daySelect = row?.querySelector<HTMLSelectElement>("[data-cand-day]");
    adoptCandidate(adopt.dataset.candAdopt || "", Number(daySelect?.value || 0));
    return;
  }
  const del = t.closest<HTMLElement>("[data-cand-del]");
  if (del) {
    removeCandidate(del.dataset.candDel || "");
  }
});

function commitCandInput(): void {
  const v = candInput.value.trim();
  if (!v) return;
  addCandidate(v);
  candInput.value = "";
  candInput.focus();
}
qs<HTMLButtonElement>("[data-cand-add]").addEventListener("click", commitCandInput);
watchComposition(candInput);
candInput.addEventListener("keydown", (e) => {
  if (isComposingKey(e)) return;
  if (e.key === "Enter") {
    e.preventDefault();
    commitCandInput();
  }
});

async function shareInvite(name: string, userId = ""): Promise<void> {
  if (state.editorLocked) return;
  if (!model.title.trim()) { toast("先に旅行名を入力してください"); return; }
  if (!state.slug) { state.slug = TripPlans.uniqueSlug(model.title); model.slug = state.slug; }
  if (!(await persist(true))) {
    toast("計画を保存できなかったため、招待を作成しませんでした");
    return;
  }
  const data = buildData();
  const meta = TripPlans.get(state.slug);
  if (meta && !canManagePlan(meta)) { toast("招待できるのは計画の所有者だけです"); return; }
  const planId = TripPlans.planIdOf(state.slug);
  if (!planId) { toast("保存してから招待してください"); return; }
  let link = "";
  let createdInviteId = "";
  try {
    const invite = await db.createInvite(planId, {
      invited_name: name, invited_user_id: userId || undefined, role: "editor",
    });
    createdInviteId = invite.id;
    link = await buildInviteLink({
      v: 1,
      meta: {
        slug: state.slug,
        title: model.title,
        dates: datesString(),
        members: model.members,
        route: (data.cities || []).map((c) => c.name).filter(Boolean).join("→"),
        updatedAt: TripPlans.get(state.slug)?.updatedAt,
      },
      token: invite.token,
      invitedName: name,
      role: "editor",
    });
  } catch (error) {
    // 権限なし・回数制限・期限切れが黙って失敗にならないよう、理由ごと知らせる
    toast(errorMessage(error) || "招待リンクを作成できませんでした");
    return;
  }
  const shareData = {
    title: model.title || "旅行計画",
    text: `「${model.title || "旅行"}」に${name ? `${name}さんを` : ""}招待します`,
    url: link,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch {
      if (createdInviteId) await db.revokeInvite(planId, createdInviteId).catch(() => undefined);
      void renderActiveInvites();
      return;
    }
  }
  try { await navigator.clipboard.writeText(link); toast("招待リンクをコピーしました"); }
  catch {
    const copied = window.prompt("招待リンクをコピーしてください", link);
    if (copied === null && createdInviteId) await db.revokeInvite(planId, createdInviteId).catch(() => undefined);
  }
  void renderActiveInvites();
}

// ---- カレンダー連携（Google テンプレート / .ics） ----------------------


function fmtMd(iso: string): string {
  const d = parseISO(iso);
  return d ? mdOf(d) : "";
}

/** カレンダー予定の説明文: メンバー・訪問地に加え、日ごとの詳細を書き出す。 */
function tripDescription(): string {
  const data = buildData();
  const lines: string[] = [];
  if (model.members) lines.push(`メンバー: ${model.members}`);
  const cities = model.cities.map((c) => c.name).filter(Boolean);
  if (cities.length) lines.push(`訪問地: ${cities.join(" → ")}`);
  if (model.note) lines.push(model.note);

  const byDate = new Map<string, ItineraryItem[]>();
  (data.itinerary || []).forEach((it) => {
    const key = it.date || "";
    if (!key) return;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(it);
  });
  const dates = Array.from(byDate.keys()).sort();
  if (dates.length) {
    lines.push("", "【日程】");
    dates.forEach((d) => {
      const items = byDate.get(d)!;
      const area = items.map((it) => it.area).find(Boolean) || "";
      const dayLabel = items[0]?.day || "";
      lines.push(`■ ${[dayLabel, fmtMd(d), area].filter(Boolean).join(" ")}`);
      items.forEach((it) => {
        const head = [it.typeLabel, it.title].filter(Boolean).join(" ") || it.place || "予定";
        const place = it.place && it.place !== it.title ? `（${it.place}）` : "";
        const time = it.time ? `${it.time} ` : "";
        lines.push(`  ${time}${head}${place}`);
      });
    });
  }
  return lines.join("\n");
}

/** 旅行全体を1つの終日イベントとして組み立てる。期間未設定なら null。 */
function planSpanEvent(): CalEvent | null {
  const s = parseISO(model.startDate);
  if (!s) return null;
  const e = parseISO(model.endDate) || s;
  const start = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  const endExclusive = new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1);
  const cities = model.cities.map((c) => c.name).filter(Boolean);
  return { title: model.title || "旅行", start, end: endExclusive, allDay: true, details: tripDescription(), location: cities[0] || "" };
}

/** 各行程アイテムを時刻付きイベントにする（.ics 用）。 */
function itineraryEvents(): CalEvent[] {
  const data = buildData();
  const out: CalEvent[] = [];
  (data.itinerary || []).forEach((it) => {
    const d = parseISO(it.date);
    if (!d) return;
    const [hhRaw, mmRaw] = String(it.time || "").split(":");
    const hh = Number(hhRaw);
    const mm = Number(mmRaw);
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const title = [it.typeLabel, it.title || it.place].filter(Boolean).join(" ") || "予定";
    out.push({ title, start, end, allDay: false, location: it.place || it.mapQuery || "", details: it.note || "" });
  });
  return out;
}

function updateCalsync(): void {
  const ok = Boolean(parseISO(model.startDate));
  gcalBtn.disabled = !ok;
  icsBtn.disabled = !ok;
}

gcalBtn.addEventListener("click", () => {
  const ev = planSpanEvent();
  if (!ev) { toast("先に期間を設定してください"); return; }
  window.open(gcalUrl(ev), "_blank", "noopener");
});

icsBtn.addEventListener("click", () => {
  const span = planSpanEvent();
  if (!span) { toast("先に期間を設定してください"); return; }
  const ics = buildIcs(model.title || "旅行", [span, ...itineraryEvents()], new Date());
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (model.title || "trip").replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "") + ".ics";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("カレンダー(.ics)を書き出しました");
});

watchComposition(cityInput);
cityInput.addEventListener("keydown", (e) => {
  // 日本語入力の変換確定も Enter で来る。ここで追加してしまうと、
  // 追加のあとに確定した文字が入力欄へ書き戻されて残ってしまう。
  if (isComposingKey(e)) return;
  if (e.key === "Enter") { e.preventDefault(); void addCity(cityInput.value); }
});
qs<HTMLButtonElement>("[data-city-add]").addEventListener("click", () => {
  void addCity(cityInput.value);
});

// 都市の滞在期間（開始/終了日）の割り当て
citiesEl.addEventListener("change", (event) => {
  const t = event.target;
  if (!(t instanceof HTMLSelectElement)) return;
  const fromId = t.getAttribute("data-city-from");
  const toId = t.getAttribute("data-city-to");
  const city = model.cities.find((c) => c.id === Number(fromId || toId || 0));
  if (!city) return;
  if (fromId) { city.fromDate = t.value; if (!city.toDate || city.toDate < city.fromDate) city.toDate = city.fromDate; }
  if (toId) { city.toDate = t.value; if (!city.fromDate || city.fromDate > city.toDate) city.fromDate = city.toDate; }
  markDirty();
  renderCities();
  renderDays();
  refreshMap(false);
});

// 都市の削除・地図検索
citiesEl.addEventListener("click", (event) => {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const pickBtn = t.closest<HTMLElement>("[data-city-geo-pick]");
  if (pickBtn) {
    const id = Number(pickBtn.dataset.cityGeoPick || 0);
    const city = model.cities.find((entry) => entry.id === id);
    const result = cityGeoCache.get(id)?.[Number(pickBtn.dataset.idx || 0)];
    if (!city || !result) return;
    city.lat = String(result.lat);
    city.lng = String(result.lng);
    cityGeoRequestSeq.set(id, (cityGeoRequestSeq.get(id) || 0) + 1);
    cityGeoCache.delete(id);
    markDirty();
    renderCities();
    renderDays();
    refreshMap(true);
    return;
  }
  const delBtn = t.closest<HTMLElement>("[data-city-del]");
  if (delBtn) {
    const id = Number(delBtn.dataset.cityDel || 0);
    cityGeoRequestSeq.set(id, (cityGeoRequestSeq.get(id) || 0) + 1);
    cityGeoCache.delete(id);
    model.cities = model.cities.filter((c) => c.id !== id);
    markDirty();
    renderCities();
    renderDays();
    refreshMap(true);
    return;
  }
  const pinBtn = t.closest<HTMLElement>("[data-city-pin]");
  if (pinBtn) {
    armCity(Number(pinBtn.dataset.cityPin || 0), pinBtn);
    return;
  }
  const geoBtn = t.closest<HTMLElement>("[data-city-geo]");
  if (geoBtn) {
    const city = model.cities.find((c) => c.id === Number(geoBtn.dataset.cityGeo || 0));
    if (!city || !city.name.trim()) return;
    void searchCity(city);
  }
});

// 都市名の編集（フォーカス維持のため renderCities はしない）
citiesEl.addEventListener("input", (event) => {
  const t = event.target;
  if (!(t instanceof HTMLInputElement)) return;
  const id = t.getAttribute("data-city-name");
  if (id === null) return;
  const city = model.cities.find((c) => c.id === Number(id));
  if (!city) return;
  const previousName = city.name;
  city.name = t.value;
  if (previousName !== city.name) {
    city.lat = "";
    city.lng = "";
    cityGeoRequestSeq.set(city.id, (cityGeoRequestSeq.get(city.id) || 0) + 1);
    cityGeoCache.delete(city.id);
    const resultsEl = citiesEl.querySelector<HTMLElement>(`[data-city-geores="${city.id}"]`);
    if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  }
  const hit = TripPlans.coordsFor(city.name);
  if (hit) { city.lat = String(hit.lat); city.lng = String(hit.lng); }
  cityOptions.innerHTML = model.cities.map((c) => `<option value="${escapeHtml(c.name)}">`).join("");
  markDirty();
  renderDays();
  scheduleMapRefresh();
});

// ---- 保存・読み込み -----------------------------------------------------

function syncBasicInputs(): void {
  qs<HTMLInputElement>('[data-f="title"]').value = model.title || "";
  qs<HTMLInputElement>('[data-f="note"]').value = model.note || "";
  updateCoverPreview();
  updateMemberVisibility();
  renderMembers();
  renderMemberSelect();
  if (model.startDate && model.endDate) fp.setDate([model.startDate, model.endDate], false);
  updateRangeButton();
  titleEcho.textContent = model.title || "新しい計画";
  updateCalsync();
}

function loadExisting(): boolean {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (meta && meta.source && meta.source !== "local") {
    return lockEditor("この計画は外部連携のため、ここでは編集できません");
  }
  // 持ち主が居ない計画（権限行もメンバー名も無い）は、名前未設定の本人まで締め出さない。
  // ダッシュボードの computeReadOnly と同じ判定に揃えている。
  if (meta && planHasOwner(meta) && !canEditPlan(meta)) {
    return lockEditor("この計画を編集する権限がありません");
  }
  const data = state.slug ? TripPlans.getData(state.slug) : null;
  if (!data) return true;
  const trip = data.trip || { title: "", dates: "", members: "", note: "" };
  model.title = trip.title || "";
  model.members = trip.members || "";
  model.memberIds = meta?.memberIds ? [...meta.memberIds] : [];
  model.memberDates = {};
  if (meta?.id) {
    for (const period of TripPlans.memberPeriods(meta.id)) {
      model.memberDates[period.user_id] = { from: period.from_date, to: period.to_date };
    }
  }
  model.note = trip.note || "";
  model.cover = trip.cover || "";
  model.candidates = Array.isArray(data.candidates) ? data.candidates : [];
  model.visibility = meta?.visibility;
  const parts = String(trip.dates || "").split(/\s+-\s+/);
  model.startDate = normalizeToISO(trip.startDate) || normalizeToISO(parts[0]);
  model.endDate = normalizeToISO(trip.endDate) || normalizeToISO(parts[1] || parts[0]);

  const byDate: Record<string, Day> = {};
  const cityNames = new Set<string>();
  (data.itinerary || []).forEach((row) => {
    const date = normalizeToISO(row.date);
    if (!date) return;
    const day = byDate[date] || (byDate[date] = { date, area: row.area || "", items: [], stay: null });
    if (!day.area && row.area) day.area = row.area;
    if (row.area) cityNames.add(row.area);
    const kind = normalizeKind(row.type);
    const it = newItem(kind, {
      time: String(row.time || ""), title: String(row.title || ""), place: String(row.place || ""),
      mapQuery: String(row.mapQuery || ""), note: String(row.note || ""),
      lat: row.lat != null ? String(row.lat) : "", lng: row.lng != null ? String(row.lng) : "",
      from: String(row.origin || ""), to: String(row.destination || ""),
      fromLat: row.originLat != null ? String(row.originLat) : "", fromLng: row.originLng != null ? String(row.originLng) : "",
      toLat: row.destinationLat != null ? String(row.destinationLat) : "", toLng: row.destinationLng != null ? String(row.destinationLng) : "",
      transport: String(row.transport || ""), duration: String(row.duration || ""),
      members: Array.isArray(row.members) ? row.members.filter((x): x is string => typeof x === "string" && Boolean(x)) : [],
    });
    if (kind === "stay") day.stay = it;
    else day.items.push(it);
  });
  // 古い計画でplans側の期間が欠けていても、保存済み行程の日付から復旧する。
  const itineraryDates = Object.keys(byDate).sort();
  if (!model.startDate) model.startDate = itineraryDates[0] || "";
  if (!model.endDate) model.endDate = itineraryDates[itineraryDates.length - 1] || model.startDate;
  model.days = Object.keys(byDate).sort().map((d) => byDate[d]);
  // 同名の宿が連日なら連泊として1つにまとめる（後ろから前へ畳む）
  for (let i = model.days.length - 1; i >= 1; i--) {
    const cur = model.days[i].stay;
    const prev = model.days[i - 1].stay;
    if (cur && prev && cur.title && cur.title === prev.title) {
      prev.nights = Math.max(1, prev.nights) + Math.max(1, cur.nights);
      model.days[i].stay = null;
    }
  }
  if (data.cities && data.cities.length) {
    // 保存済みの都市（期間つき）を復元
    model.cities = data.cities.map((c) => {
      const itineraryPoint = (data.itinerary || []).find((item) =>
        item.area === c.name && String(item.lat ?? "").trim() !== "" && String(item.lng ?? "").trim() !== "" &&
        Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)),
      );
      const known = TripPlans.coordsFor(c.name || "");
      return {
        id: state.seq++, name: c.name || "",
        fromDate: c.fromDate || itineraryDates.find((date) => byDate[date]?.area === c.name) || "",
        toDate: c.toDate || [...itineraryDates].reverse().find((date) => byDate[date]?.area === c.name) || "",
        lat: c.lat != null && String(c.lat) !== ""
          ? String(c.lat) : itineraryPoint ? String(itineraryPoint.lat) : known ? String(known.lat) : "",
        lng: c.lng != null && String(c.lng) !== ""
          ? String(c.lng) : itineraryPoint ? String(itineraryPoint.lng) : known ? String(known.lng) : "",
      };
    });
  } else {
    // 旧データ：行程の area から都市名だけ拾う（期間は空）
    model.cities = Array.from(cityNames).map((name) => {
      const hit = TripPlans.coordsFor(name);
      return { id: state.seq++, name, lat: hit ? String(hit.lat) : "", lng: hit ? String(hit.lng) : "", fromDate: "", toDate: "" };
    });
  }
  return true;
}


async function save(): Promise<void> {
  if (state.editorLocked) {
    statusEl.textContent = "この計画を編集する権限がありません";
    statusEl.className = "is-dirty";
    return;
  }
  setSaveActionsBusy(true);
  try {
    await persist(true);
  } finally {
    setSaveActionsBusy(false);
  }
}

function focusPublishError(field: "title" | "dates" | "cities", step: 1 | 2): void {
  setViewStep(step);
  if (field === "title") qs<HTMLInputElement>('[data-f="title"]').focus();
  else if (field === "dates") rangeTrigger.focus();
  else cityInput.focus();
}

function publish(): void {
  if (state.editorLocked) return;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (meta && !canManagePlan(meta)) {
    statusEl.textContent = "公開設定を変更できるのは計画の所有者だけです";
    statusEl.className = "is-dirty";
    return;
  }
  const invalid = validatePublishPlan(model);
  if (!TripPlans.isPublished(meta || { published: false }) && invalid) {
    statusEl.textContent = invalid.message;
    statusEl.className = "is-dirty";
    focusPublishError(invalid.field, invalid.step);
    return;
  }
  openVisibilityChooser((visibility) => { void doPublish(visibility); });
}

async function doPublish(visibility: PlanVisibility): Promise<void> {
  if (state.editorLocked) return;
  const invalid = validatePublishPlan(model);
  if (invalid) {
    statusEl.textContent = invalid.message;
    statusEl.className = "is-dirty";
    focusPublishError(invalid.field, invalid.step);
    return;
  }
  setSaveActionsBusy(true);
  if (!(await persist(true))) {
    setSaveActionsBusy(false);
    return;
  }
  const mutationCheckpoint = db.mutationCheckpoint();
  model.visibility = visibility;
  if (!TripPlans.upsert({ slug: state.slug, visibility, published: true })) {
    statusEl.textContent = "ログインしてから保存してください";
    statusEl.className = "is-dirty";
    setSaveActionsBusy(false);
    return;
  }
  TripPlans.setActiveSlug(state.slug);
  try {
    await db.flushMutations(mutationCheckpoint);
  } catch (error) {
    state.dirty = true;
    statusEl.textContent = "保存できませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
    setSaveActionsBusy(false);
    return;
  }
  state.dirty = false;
  const visLabel = visibility === "invite" ? "招待制" : "公開";
  statusEl.textContent = `保存しました（${visLabel}）`;
  statusEl.className = "is-ok";
  savebarNoteEl.textContent = `保存しました（${visLabel}）。右上の「表示」でダッシュボードを確認できます。`;
  try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(state.slug)); } catch { /* ignore */ }
  setSaveActionsBusy(false);
  navigateWithPageTransition("index.html?plan=" + encodeURIComponent(state.slug));
}

async function doUnpublish(): Promise<void> {
  if (!state.slug || state.editorLocked) return;
  setSaveActionsBusy(true);
  const mutationCheckpoint = db.mutationCheckpoint();
  if (!TripPlans.upsert({ slug: state.slug, published: false })) {
    setSaveActionsBusy(false);
    return;
  }
  try {
    await db.flushMutations(mutationCheckpoint);
    if (!(await persist(true))) throw new Error("下書きの内容を保存できませんでした");
    statusEl.textContent = "下書きに戻しました";
    statusEl.className = "is-ok";
    savebarNoteEl.textContent = "この計画は公開一覧に表示されません。";
  } catch (error) {
    statusEl.textContent = "下書きに戻せませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
  } finally {
    setSaveActionsBusy(false);
  }
}

function visOption(value: PlanVisibility, current: PlanVisibility, label: string, desc: string, glyph: IconName): string {
  const id = `pe-vis-${value}`;
  return (
    `<label class="pe-vis-opt" for="${id}">` +
    `<input type="radio" id="${id}" name="pe-vis" value="${value}"${value === current ? " checked" : ""}>` +
    `<span class="pe-vis-ic">${icon(glyph)}</span>` +
    `<span class="pe-vis-main"><b>${label}</b><small>${desc}</small></span>` +
    `</label>`
  );
}

/** 保存時に公開範囲を選ばせるモーダル。確定で onConfirm(選択値) を呼ぶ。 */
function openVisibilityChooser(onConfirm: (v: PlanVisibility) => void): void {
  // 初回は安全側の「限定」を既定にし、公開は利用者が明示的に選ぶ。
  const current: PlanVisibility = model.visibility === "public" ? "public" : "invite";
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const isPublished = Boolean(meta && TripPlans.isPublished(meta));
  const modal = document.createElement("div");
  modal.className = "pe-modal";
  modal.innerHTML =
    `<form class="pe-modal-box">` +
    `<h2>公開範囲を選択</h2>` +
    `<p class="pe-modal-sub">この計画を「みんなの計画」一覧に出すかを選びます。あとから変更できます。</p>` +
    `<div class="pe-vis-options">` +
    visOption("public", current, "公開", "「みんなの計画」一覧に載り、誰でも見られます。", "globeAlt") +
    visOption("invite", current, "限定", "一覧には出さず、招待リンクを渡した人にだけ共有します。", "users") +
    `</div>` +
    `<p class="pe-modal-note">限定は一覧に表示されず、参加者または招待リンクからログインして参加した人だけが閲覧できます。公開では行程・地図などの閲覧用情報が表示され、メンバー・費用・精算は公開されません。</p>` +
    `<div class="pe-modal-actions">` +
    (isPublished ? `<button type="button" class="pe-modal-btn ghost" data-unpublish>下書きに戻す</button>` : "") +
    `<button type="button" class="pe-modal-btn ghost" data-cancel>キャンセル</button>` +
    `<button type="submit" class="pe-modal-btn">この設定で公開</button>` +
    `</div></form>`;
  document.body.appendChild(modal);
  const form = modal.querySelector<HTMLFormElement>("form");
  modal.querySelector("[data-cancel]")?.addEventListener("click", () => modal.remove());
  modal.querySelector("[data-unpublish]")?.addEventListener("click", () => {
    modal.remove();
    void doUnpublish();
  });
  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    const picked =
      (modal.querySelector<HTMLInputElement>('input[name="pe-vis"]:checked')?.value as PlanVisibility) || current;
    modal.remove();
    onConfirm(picked);
  });
}

// ---- ヘッダーアイコン・初期化 -------------------------------------------

// 戻る（<）は共通ヘッダー側で描画済み。開くボタンだけ eye アイコンに差し替える。
function setSaveActionsBusy(busy: boolean): void {
  state.saveActionsBusy = busy;
  saveBtn.disabled = busy;
  publishBtn.disabled = busy;
  stepNextBtn.disabled = busy || (state.viewStep < 3 && !stepCompletion()[state.viewStep - 1]);
  saveBtn.innerHTML = busy ? icon("arrowPath") + "<span>保存中…</span>" : icon("bookmark") + "<span>下書きを保存</span>";
}
saveBtn.innerHTML = icon("bookmark") + "<span>下書きを保存</span>";
publishBtn.innerHTML = icon("globeAlt") + "<span>公開設定</span>";
saveBtn.addEventListener("click", () => { void save(); });
publishBtn.addEventListener("click", publish);
qs<HTMLButtonElement>("[data-city-add]").innerHTML = icon("plus") + "<span>追加</span>";
localNoteEl.innerHTML = icon("informationCircle") + (db.isEnabled()
  ? "クラウドに自動保存（公開するまでは下書き）"
  : "保存先が未設定（JSON書き出しのみ利用できます）");

// 書き出し（JSON）— ローカル保存のバックアップ
function exportJson(): void {
  const blob = new Blob([JSON.stringify(buildData(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = (model.title || "trip").replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "") + ".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
exportBtn.innerHTML = icon("documentText") + "<span>書き出し</span>";
exportBtn.addEventListener("click", exportJson);

// 地図の表示/非表示

mapClose.innerHTML = icon("xMark");
setMapHandlers({ onMapClick, applyGeo });
mapToggle.addEventListener("click", () => setMapCollapsed(!root.classList.contains("map-collapsed")));
mapHeaderBtn.addEventListener("click", () => setMapCollapsed(!root.classList.contains("map-collapsed")));
mapClose.addEventListener("pointerdown", (event) => event.stopPropagation());
mapClose.addEventListener("click", (event) => { event.stopPropagation(); setMapCollapsed(true); });

bindMapResizeGrip();

// 行のキーボード操作（Enter/Space で開閉）
function focusOpenItem(): void {
  if (state.openItemId == null) return;
  const node = daysEl.querySelector<HTMLElement>(`[data-node="${state.openItemId}"]`);
  node?.querySelector<HTMLInputElement | HTMLSelectElement>(".pe-edit input, .pe-edit select")?.focus();
}
daysEl.addEventListener("keydown", (event) => {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const row = t.closest<HTMLElement>('.pe-row[data-act="toggle"]');
  if (!row) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const id = Number(row.dataset.item || 0);
    state.openItemId = state.openItemId === id ? null : id;
    disarm();
    renderDays();
    focusOpenItem();
  }
});

// 日へジャンプ
dayStripEl.addEventListener("click", (event) => {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const chip = t.closest<HTMLElement>("[data-jump]");
  if (!chip) return;
  daysEl.querySelector<HTMLElement>(`article[data-day="${chip.dataset.jump}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

window.addEventListener("beforeunload", (event) => {
  if (state.editorLocked) return;
  if (state.dirty) { event.preventDefault(); event.returnValue = ""; }
});

// タブが背面へ移る時は、beforeunload の非同期処理に頼らず先に保存を開始する。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && state.dirty && worthSaving()) void persist();
});

// 共有ストア（MySQL）を読み終えてから既存計画を読み込む。
// 読む前に触ると「権限がありません」になったり、計画を二重に作ってしまう。
function bootstrapEditor(): void {
  if (db.isEnabled() && !currentAccount()) {
    navigateWithPageTransition(
      "login.html?returnTo=" + encodeURIComponent("plan-editor.html" + location.search),
      { replace: true },
    );
    return;
  }
  const editable = loadExisting();
  syncBasicInputs();
  rebuildDays();
  setLastSavedContentFingerprint(contentFingerprint(buildData()));
  renderCities();
  renderDays();
  renderCandidates();
  // 地図の初期表示：スマホは入力を優先し、地図は必要な時だけ開く。
  let savedMapPref: string | null = null;
  try {
    savedMapPref = localStorage.getItem("pe-map-collapsed");
  } catch { /* localStorage が使えない環境では既定の表示にする */ }
  if (window.matchMedia("(max-width: 680px)").matches) {
    setMapCollapsed(true);
  } else if (savedMapPref === "1" || (savedMapPref == null && window.matchMedia("(max-width: 760px)").matches)) {
    setMapCollapsed(true);
  }
  // 畳まない構成（PC など）はこの時点で見えているので、ここで作る。
  if (!root.classList.contains("map-collapsed")) ensureMap();
  statusEl.textContent = isNew ? "下書き（自動保存・未保存）" : editable ? "読み込み完了" : statusEl.textContent;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  state.metadataLocked = Boolean(meta && canEditPlan(meta) && !canEditPlanMetadata(meta));
  publishBtn.hidden = Boolean(meta && !canManagePlan(meta));
  if (!editable || state.editorLocked) applyEditorLock();
  else if (state.metadataLocked) applyMetadataLock();
  // ダッシュボードの「AIサポート」から来たとき（?ai=1）は、AI相談ブロックへ案内する。
  if (params.get("ai") === "1" && editable && !state.editorLocked) {
    const aiBlock = root.querySelector<HTMLElement>("[data-ai-block]");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      if (!aiBlock || !aiBlock.offsetParent) return; // スマホのステップ表示などで隠れていたら何もしない
      aiBlock.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      aiArea.focus({ preventScroll: true });
    }, 0);
  }
}

// 編集画面は控え（キャッシュ）を使わずサーバーの最新を待つ。
// 裏で snap が差し替わると、編集中の内容と食い違うため。
void db.load({ fresh: true, strict: db.isEnabled() }).then(bootstrapEditor).catch((error) => {
  lockEditor("旅行データを読み込めませんでした。接続を確認して再読み込みしてください");
  savebarNoteEl.textContent = errorMessage(error);
  applyEditorLock();
});

registerServiceWorker();
