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
import type { LocalPlanData, PlanVisibility } from "../shared/plans-store";
import type { ItineraryItem, ItemType, Candidate } from "../shared/types";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml, errorMessage } from "../shared/dom";
import { icon, type IconName } from "../shared/icons";
import { planCoverThumbnail } from "../shared/cover";
import { registerServiceWorker } from "../shared/pwa";
import { getUser } from "../shared/user-store";
import { splitNames } from "../shared/friend-store";
import { buildInviteLink } from "../shared/invite";
import { gcalUrl, buildIcs, type CalEvent } from "../shared/calendar";
import { mountAppHeader } from "../shared/app-header";
import * as Permissions from "../shared/permissions-store";
import { currentAccount } from "../shared/account-store";
import { listFriends } from "../shared/friendship-store";
import { canEditPlan, canManagePlan, planHasOwner } from "../shared/membership";
import { addBaseLayer } from "../shared/map-tiles";
import { validatePublishPlan } from "./validation";
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

initPageTransitions();

// ---- モデル -------------------------------------------------------------

type ItemKind = "sight" | "food" | "move" | "stay" | "todo" | "form";

type ItemStrKey =
  | "time" | "title" | "place" | "mapQuery" | "note" | "lat" | "lng"
  | "from" | "fromLat" | "fromLng" | "to" | "toLat" | "toLng"
  | "transport" | "duration";

interface Item {
  id: number;
  kind: ItemKind;
  time: string;
  title: string;
  place: string;
  mapQuery: string;
  note: string;
  lat: string;
  lng: string;
  // 移動用
  from: string;
  fromLat: string;
  fromLng: string;
  to: string;
  toLat: string;
  toLng: string;
  transport: string;
  duration: string;
  /** 宿泊専用：この夜から連泊する泊数（既定 1） */
  nights: number;
}

interface Day {
  date: string;
  area: string;
  items: Item[];     // 観光/食事/移動/予定/手続き
  stay: Item | null; // この夜にチェックインする宿（連泊は nights で表現）
}

/** 指定の日に「滞在中」の宿（連泊対応）。startIndex はチェックイン日。 */
function stayCovering(dayIndex: number): { startIndex: number; stay: Item } | null {
  for (let i = dayIndex; i >= 0; i--) {
    const s = model.days[i] && model.days[i].stay;
    if (s && i + Math.max(1, s.nights) > dayIndex) return { startIndex: i, stay: s };
  }
  return null;
}

interface City {
  id: number;
  name: string;
  lat: string;
  lng: string;
  /** この都市に滞在する日（任意）。設定すると日が都市の下にまとまる */
  fromDate: string;
  toDate: string;
}

/** 指定日をカバーする都市（fromDate<=date<=toDate） */
function cityForDate(date: string): City | null {
  for (const c of model.cities) {
    if (c.fromDate && c.toDate && c.fromDate <= date && date <= c.toDate) return c;
  }
  return null;
}

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

interface Model {
  slug: string;
  title: string;
  members: string;
  memberIds: string[];
  note: string;
  cover: string;
  startDate: string;
  endDate: string;
  cities: City[];
  days: Day[];
  candidates: Candidate[];
  visibility?: PlanVisibility;
}

type GeoTarget = "place" | "from" | "to";

const KINDS: Record<ItemKind, { label: string; icon: IconName }> = {
  sight: { label: "観光", icon: "camera" },
  food: { label: "食事", icon: "cake" },
  move: { label: "移動", icon: "arrowsRightLeft" },
  stay: { label: "宿泊", icon: "buildingOffice2" },
  todo: { label: "予定", icon: "check" },
  form: { label: "手続き", icon: "documentText" },
};

const KIND_COLOR: Record<ItemKind, string> = {
  sight: "#0b5a42", food: "#b87418", move: "#22719d", stay: "#cf4f3d", todo: "#68746e", form: "#6246a6",
};

const TRANSPORTS = ["電車", "新幹線", "飛行機", "車", "バス", "フェリー", "徒歩", "その他"];

/**
 * 行程の行に出す移動手段のアイコン。
 * heroicons に電車・バス・船・徒歩の絵柄がないので、
 * 陸路（車・バス）は truck、鉄道と船は ticket（きっぷを買う移動）に寄せる。
 * 正確な手段名は title と展開後の選択欄に残す。
 */
const TRANSPORT_ICONS: Record<string, IconName> = {
  電車: "ticket",
  新幹線: "ticket",
  フェリー: "ticket",
  飛行機: "paperAirplane",
  車: "truck",
  バス: "truck",
  徒歩: "user",
  その他: "arrowsRightLeft",
};

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

// ---- DOM ----------------------------------------------------------------

function qs<E extends Element = HTMLElement>(parent: ParentNode, selector: string): E {
  const el = parent.querySelector<E>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

const root = document.getElementById("editor");
if (!root) throw new Error("エディタのルート要素が見つかりません: #editor");

mountAppHeader({
  kicker: "Plan Editor",
  title: "新しい計画",
  titleAttr: "data-title-echo",
  back: { href: "plans.html", label: "計画一覧へ戻る", attr: "data-back" },
  meta: [{ attr: "data-status" }],
  actions: [
    {
      kind: "link",
      display: "icon",
      icon: "arrowTopRightOnSquare",
      label: "ダッシュボードで表示",
      href: "index.html",
      attr: "data-open",
      hidden: true,
    },
  ],
});

const daysEl = qs<HTMLElement>(root, "[data-days]");
const statusEl = qs<HTMLElement>(root, "[data-status]");
const titleEcho = qs<HTMLElement>(root, "[data-title-echo]");
const openLink = qs<HTMLAnchorElement>(root, "[data-open]");
const warnEl = qs<HTMLElement>(root, "[data-daterange-warn]");
const dayCountEl = qs<HTMLElement>(root, "[data-day-count]");
const savebarNoteEl = qs<HTMLElement>(root, "[data-savebar-note]");
const stepReasonEl = qs<HTMLElement>(root, "[data-step-reason]");
const citiesEl = qs<HTMLElement>(root, "[data-cities]");
const cityInput = qs<HTMLInputElement>(root, "[data-city-input]");
const cityOptions = qs<HTMLDataListElement>(document, "#pe-city-options");
const mapEl = qs<HTMLElement>(root, "[data-map]");
const mapHintEl = qs<HTMLElement>(root, "[data-map-hint]");
const rangeEl = qs<HTMLInputElement>(root, "[data-range]");
const rangeTrigger = qs<HTMLButtonElement>(root, "[data-range-trigger]");
const rangeLabel = qs<HTMLElement>(root, "[data-range-label]");
const dayStripEl = qs<HTMLElement>(root, "[data-daystrip]");
const tripSummaryEl = qs<HTMLElement>(root, "[data-trip-summary]");

// セクション見出しにアイコン
qs<HTMLElement>(root, "[data-ic-route]").insertAdjacentHTML("afterbegin", icon("map") + " ");
qs<HTMLElement>(root, "[data-ic-days]").insertAdjacentHTML("afterbegin", icon("calendarDays") + " ");
qs<HTMLElement>(root, "[data-ic-cand]").insertAdjacentHTML("afterbegin", icon("star") + " ");

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

// ---- 初期状態 -----------------------------------------------------------

const params = new URLSearchParams(location.search);
const planParam = (params.get("plan") || "").trim();
const isNew = !planParam;
let slug = isNew ? "" : TripPlans.safeSlug(planParam);

const model: Model = {
  slug, title: "", members: "", memberIds: [], note: "", cover: "", startDate: "", endDate: "", cities: [], days: [], candidates: [],
};
let dirty = false;
let editRevision = 0;
let lastSavedContentFingerprint = "";
let persistRunning: Promise<boolean> | null = null;
let persistRequested = false;
let saveActionsBusy = false;
let seq = 1;
let openItemId: number | null = null;
let armed: { itemId: number; target: GeoTarget } | null = null;
// 地図クリックで訪問地の位置を決めるときの対象（都市の id）
let armedCity: number | null = null;
let editorLocked = false;

function lockEditor(message: string): false {
  editorLocked = true;
  statusEl.textContent = message;
  statusEl.className = "is-dirty";
  savebarNoteEl.textContent = message;
  return false;
}

function applyEditorLock(): void {
  root!.classList.add("is-readonly");
  root!.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(
    "input, select, textarea, button",
  ).forEach((control) => {
    control.disabled = true;
  });
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

function newItem(kind: ItemKind, seed?: Partial<Item>): Item {
  return {
    id: seq++, kind,
    time: seed?.time ?? "", title: seed?.title ?? "", place: seed?.place ?? "",
    mapQuery: seed?.mapQuery ?? "", note: seed?.note ?? "",
    lat: seed?.lat ?? "", lng: seed?.lng ?? "",
    from: seed?.from ?? "", fromLat: seed?.fromLat ?? "", fromLng: seed?.fromLng ?? "",
    to: seed?.to ?? "", toLat: seed?.toLat ?? "", toLng: seed?.toLng ?? "",
    transport: seed?.transport ?? "", duration: seed?.duration ?? "",
    nights: seed?.nights ?? 1,
  };
}

// ---- 日付ユーティリティ -------------------------------------------------

function pad(n: number): string { return n < 10 ? "0" + n : String(n); }
function toISO(d: Date): string { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function parseISO(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}
function weekday(d: Date): string { return ["日", "月", "火", "水", "木", "金", "土"][d.getDay()]; }
function datesString(): string {
  const a = parseISO(model.startDate);
  const b = parseISO(model.endDate);
  if (!a || !b) return "";
  const f = (d: Date): string => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${f(a)} - ${f(b)}`;
}
// 時刻文字列を分に変換（並べ替え用）。HH:MM と 朝/昼/夕/夜 に対応。
function timeOrder(s: string): number {
  const t = String(s || "");
  const m = /(\d{1,2}):(\d{2})/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/朝|午前|モーニング/i.test(t)) return 8 * 60;
  if (/昼|正午|ランチ/i.test(t)) return 12 * 60;
  if (/夕/.test(t)) return 17 * 60;
  if (/夜|ディナー|晩/i.test(t)) return 19 * 60;
  return 9000;
}

function normalizeToISO(value: string | undefined): string {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : "";
}

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

function cityDateDefault(index: number): string {
  const firstDay = model.days[0]?.date || model.startDate || "";
  if (index <= 0) return firstDay;
  const prev = model.cities[index - 1];
  return prev?.toDate || prev?.fromDate || firstDay;
}

function applyCityDateDefaults(): void {
  if (!model.days.length) return;
  model.cities.forEach((city, index) => {
    if (!city.fromDate) city.fromDate = cityDateDefault(index);
    if (!city.toDate) city.toDate = city.fromDate;
  });
}

// ---- 座標補完・ジオコーディング -----------------------------------------

function num(s: string): number { return Number(String(s).trim()); }
function hasLatLng(lat: string, lng: string): boolean {
  return String(lat).trim() !== "" && String(lng).trim() !== "" && !isNaN(num(lat)) && !isNaN(num(lng));
}

function autoCoords(item: Item, target: GeoTarget): void {
  const [latKey, lngKey] = latLngKeys(target);
  if (hasLatLng(item[latKey], item[lngKey])) return;
  const name = target === "from" ? item.from : target === "to" ? item.to : (item.place || item.mapQuery);
  const hit = TripPlans.coordsFor(name);
  if (hit) { item[latKey] = String(hit.lat); item[lngKey] = String(hit.lng); }
}

function clearItemCoords(item: Item, target: GeoTarget): void {
  const [latKey, lngKey] = latLngKeys(target);
  item[latKey] = "";
  item[lngKey] = "";
}

function latLngKeys(target: GeoTarget): [ItemStrKey, ItemStrKey] {
  if (target === "from") return ["fromLat", "fromLng"];
  if (target === "to") return ["toLat", "toLng"];
  return ["lat", "lng"];
}

const MAPBOX_TOKEN = readGlobalTripConfig().geocoding?.mapboxToken || "";

function geocodeSearch(query: string, context?: GeoContext, automatic = false): Promise<GeoResult[]> {
  return searchLocations(query, context, { mapboxToken: MAPBOX_TOKEN, automatic });
}

// ---- 検索・参照ヘルパー -------------------------------------------------

interface Found { day: Day; item: Item; }
function findItem(id: number): Found | null {
  for (const day of model.days) {
    for (const it of day.items) if (it.id === id) return { day, item: it };
    if (day.stay && day.stay.id === id) return { day, item: day.stay };
  }
  return null;
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

function inclusiveDateCount(from: string, to: string): number {
  const a = parseISO(from);
  const b = parseISO(to);
  if (!a || !b || b < a) return 1;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
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

let persistTimer = 0;
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

function markDirty(): void {
  if (editorLocked) return;
  dirty = true;
  editRevision += 1;
  statusEl.textContent = model.title.trim() || hasContent()
    ? "編集中…"
    : "旅行名か行程を入れると自動保存されます";
  statusEl.className = "is-dirty";
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => { void persist(); }, 900);
  updateSteps();
}

function nowHM(): string {
  const d = new Date();
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

const UNTITLED = "無題の旅行";

/**
 * 旅行名以外に何か入力されているか。
 *
 * 以前は旅行名が空だと persist() が即 return していたため、期間・訪問地・
 * 行程を作り込んでも旅行名を入れずに離れると、ローカルにも DB にも
 * 何も残らず消えていた。かといって開いただけで下書きを作ると空の計画が
 * 量産されるので、「実際に何か入れたら残す」を境目にする。
 */
function hasContent(): boolean {
  if (model.note.trim() || model.startDate || model.endDate) return true;
  if (model.cities.some((c) => c.name.trim())) return true;
  if (model.candidates.length) return true;
  return model.days.some((d) => d.items.length > 0 || d.stay !== null || d.area.trim());
}

/** 保存する価値がある状態か（旅行名が空でも中身があれば下書きとして残す）。 */
function worthSaving(): boolean {
  return Boolean(model.title.trim()) || hasContent();
}

function contentFingerprint(data: LocalPlanData): string {
  return JSON.stringify({
    itinerary: data.itinerary || [],
    cities: data.cities || [],
    links: data.links || [],
    checklist: data.checklist || [],
    candidates: data.candidates || [],
  });
}

/**
 * 1回分の保存処理。旅行名・メモなどメタ情報だけの変更では本文を全置換しない。
 * 行程等が変わった時だけ content API を使う。
 */
async function performPersist(explicit = false): Promise<boolean> {
  if (editorLocked) return false;
  if (!worthSaving()) {
    if (explicit) {
      statusEl.textContent = "旅行名または旅行内容を入力してください";
      statusEl.className = "is-dirty";
    }
    return false;
  }
  const revision = editRevision;
  const mutationCheckpoint = db.mutationCheckpoint();
  if (!slug) {
    slug = TripPlans.uniqueSlug(model.title.trim() || UNTITLED);
    model.slug = slug;
    openLink.href = "index.html?plan=" + encodeURIComponent(slug);
    openLink.hidden = false;
    try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(slug)); } catch { /* ignore */ }
  }
  Permissions.ensureOwner(slug, model.members);
  const data = buildData();
  const nextContentFingerprint = contentFingerprint(data);
  const contentChanged = nextContentFingerprint !== lastSavedContentFingerprint;
  const existing = TripPlans.get(slug);
  const saved = contentChanged
    ? TripPlans.saveLocalPlan(slug, data, model.memberIds)
    : TripPlans.upsert({
      slug,
      title: model.title.trim() || UNTITLED,
      dates: datesString(),
      members: model.members,
      memberIds: model.memberIds,
      note: model.note,
      cover: model.cover,
      ...(!existing ? { source: "local" as const, published: false } : {}),
    });
  if (!saved) {
    dirty = true;
    statusEl.textContent = "ログインしてから保存してください";
    statusEl.className = "is-dirty";
    return false;
  }
  TripPlans.setActiveSlug(slug);
  try {
    await db.flushMutations(mutationCheckpoint);
    if (contentChanged) lastSavedContentFingerprint = nextContentFingerprint;
    if (revision !== editRevision) return true;
    dirty = false;
    statusEl.textContent = explicit
      ? `下書きを保存しました ${nowHM()}`
      : model.title.trim()
        ? `自動保存しました ${nowHM()}`
      : `下書きを保存しました ${nowHM()}（旅行名は未入力）`;
    statusEl.className = "is-ok";
    savebarNoteEl.textContent = "";
    return true;
  } catch (error) {
    dirty = true;
    statusEl.textContent = "保存できませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
    return false;
  }
}

// 自動保存。連続入力中の保存要求は同時実行せず、最新状態を最後にもう一度保存する。
async function persist(explicit = false): Promise<boolean> {
  window.clearTimeout(persistTimer);
  if (persistRunning) {
    persistRequested = true;
    const result = await persistRunning;
    if (explicit && dirty) return persist(true);
    return result;
  }
  persistRunning = performPersist(explicit);
  const result = await persistRunning.finally(() => { persistRunning = null; });
  if (persistRequested) {
    persistRequested = false;
    void persist();
  }
  return result;
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

/** 表示中のステップ（1=期間 / 2=目的地 / 3=行程）。0 は未初期化。 */
let viewStep = 0;

function stepCompletion(): boolean[] {
  const periodDone = Boolean(model.title.trim()) && model.days.length > 0;
  const placeDone = model.cities.length > 0;
  const planDone = model.days.some((d) => d.items.length > 0 || d.stay);
  return [periodDone, placeDone, planDone];
}

function stepBlockReason(step: number): string {
  if (step === 1) {
    if (!model.title.trim() && !model.days.length) return "旅行名と期間を入れると目的地へ進めます。";
    if (!model.title.trim()) return "旅行名を入れると目的地へ進めます。";
    if (!model.days.length) return "期間を選択すると目的地へ進めます。";
  }
  if (step === 2 && !model.cities.length) return "訪問する都市・エリアを1つ以上追加すると行程へ進めます。";
  return "";
}

function scrollStepIntoView(): void {
  const target = document.querySelector<HTMLElement>(".pe-setup");
  if (!target) return;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.setTimeout(() => target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" }), 0);
}

/** 作成ステップ（期間→目的地→行程）を実状態に連動させ、スマホでは該当パネルだけ表示。 */
function updateSteps(): void {
  const done = stepCompletion();
  if (viewStep === 0) {
    const natural = done.findIndex((d) => !d);
    viewStep = natural < 0 ? done.length : natural + 1;
  }
  const pe = document.getElementById("editor");
  if (pe) pe.dataset.step = String(viewStep);
  if (viewStep === 1 && root) {
    root.classList.add("map-collapsed");
    const showBtn = root.querySelector<HTMLButtonElement>("[data-map-show]");
    if (showBtn) showBtn.hidden = true;
  } else if (root) {
    const showBtn = root.querySelector<HTMLButtonElement>("[data-map-show]");
    if (showBtn) showBtn.hidden = !root.classList.contains("map-collapsed");
  }
  document.querySelectorAll<HTMLElement>(".pe-step").forEach((el, i) => {
    const isDone = done[i] && i + 1 !== viewStep;
    el.classList.toggle("is-done", isDone);
    el.classList.toggle("is-current", i + 1 === viewStep);
    const numEl = el.querySelector<HTMLElement>(".pe-step-n");
    if (numEl) numEl.innerHTML = isDone ? icon("check") : String(i + 1);
  });
  const prevBtn = document.querySelector<HTMLButtonElement>("[data-step-prev]");
  const nextBtn = document.querySelector<HTMLButtonElement>("[data-step-next]");
  if (prevBtn) {
    prevBtn.disabled = viewStep <= 1;
    const label = viewStep <= 2 ? "戻る" : "目的地へ戻る";
    prevBtn.innerHTML = icon("chevronLeft") + `<span>${label}</span>`;
  }
  if (nextBtn) {
    nextBtn.hidden = false;
    nextBtn.disabled = saveActionsBusy || (viewStep < 3 && !done[viewStep - 1]);
    const label = viewStep === 1 ? "目的地へ" : viewStep === 2 ? "行程へ" : "公開設定へ";
    const glyph = viewStep === 3 ? "globeAlt" : "chevronRight";
    nextBtn.innerHTML = `<span>${label}</span>` + icon(glyph);
  }
  stepReasonEl.textContent = viewStep < 3 && !done[viewStep - 1] ? stepBlockReason(viewStep) : "";
}

/** ステップのタップで表示を切り替える（スマホのウィザード送り）。 */
function setViewStep(step: number): void {
  const target = Math.min(3, Math.max(1, step));
  if (target > viewStep) {
    const done = stepCompletion();
    for (let current = viewStep; current < target; current += 1) {
      if (!done[current - 1]) {
        stepReasonEl.textContent = stepBlockReason(current);
        return;
      }
    }
  }
  viewStep = target;
  updateSteps();
  scrollStepIntoView();
}

document.querySelectorAll<HTMLElement>(".pe-step").forEach((el, i) => {
  el.addEventListener("click", () => setViewStep(i + 1));
});

document.querySelector<HTMLButtonElement>("[data-step-prev]")?.addEventListener("click", () => {
  setViewStep(viewStep - 1);
});

document.querySelector<HTMLButtonElement>("[data-step-next]")?.addEventListener("click", () => {
  const done = stepCompletion();
  if (viewStep >= 3) {
    publish();
    return;
  }
  if (!done[viewStep - 1]) return;
  setViewStep(viewStep + 1);
});

function renderCities(): void {
  updateSteps();
  cityOptions.innerHTML = model.cities.map((c) => `<option value="${escapeHtml(c.name)}">`).join("");
  if (!model.cities.length) {
    citiesEl.innerHTML = `<span class="pe-route-empty">訪問地はまだありません。都市やエリアを追加すると地図に表示されます。期間を設定すると、滞在日も指定できます。</span>`;
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

async function addCity(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const local = TripPlans.coordsFor(trimmed);
  const fromDate = cityDateDefault(model.cities.length);
  const city: City = {
    id: seq++,
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
    end
  );
}

function timelineNode(item: Item): string {
  const open = openItemId === item.id ? " is-open" : "";
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
  const open = openItemId === stay.id ? " is-open" : "";
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
      const items = day.items.map(timelineNode).join("");
      const empty = day.items.length ? "" : `<p class="pe-day-empty">予定はまだありません。下のボタンから追加できます。</p>`;
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
          openItemId = null;
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
  daysEl.querySelectorAll<HTMLElement>("article[data-day]").forEach((article) => {
    const di = Number(article.dataset.day);
    const day = model.days[di];
    if (!day) return;
    const ids = Array.from(article.querySelectorAll<HTMLElement>(".pe-timeline > .pe-node")).map((n) => Number(n.dataset.node));
    day.items = ids.map((id) => all.get(id)).filter((x): x is Item => Boolean(x));
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

// ---- 地図（Leaflet ライブ） ---------------------------------------------

let map: L.Map | null = null;
let pinLayer: L.LayerGroup | null = null;
let routeLayer: L.LayerGroup | null = null;
let candidateLayer: L.LayerGroup | null = null;

function initMap(): void {
  map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([39.6, 140.6], 6);
  addBaseLayer(L, map);
  pinLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  candidateLayer = L.layerGroup().addTo(map);
  map.on("click", (e: L.LeafletMouseEvent) => onMapClick(e.latlng));
  window.setTimeout(() => map && map.invalidateSize(), 60);
}

function pinIcon(color: string, label: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<div class="pe-pin" style="background:${color}"><span>${escapeHtml(label)}</span></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  });
}

// 検索候補を地図上に番号ピンで表示。クリックで採用。
function showCandidates(itemId: number, target: GeoTarget, results: GeoResult[]): void {
  if (!map || !candidateLayer) return;
  candidateLayer.clearLayers();
  const pts: L.LatLngTuple[] = [];
  results.forEach((r, i) => {
    const ll: L.LatLngTuple = [r.lat, r.lng];
    pts.push(ll);
    const marker = L.marker(ll, {
      icon: L.divIcon({ className: "", html: `<div class="pe-candpin">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
      zIndexOffset: 1000,
    }).bindTooltip(`候補${i + 1}: ${escapeHtml(r.label)}`, { direction: "top" });
    marker.on("click", () => applyGeo(itemId, target, r));
    marker.addTo(candidateLayer!);
  });
  if (pts.length && map) map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 14 });
  mapHintEl.textContent = "地図の候補ピンをクリックして選択";
}

function clearCandidates(): void {
  if (candidateLayer) candidateLayer.clearLayers();
}

function refreshMap(fit: boolean): void {
  if (!map || !pinLayer || !routeLayer) return;
  pinLayer.clearLayers();
  routeLayer.clearLayers();
  const pts: L.LatLngTuple[] = [];

  // 都市（薄いグレーのピン）
  model.cities.forEach((c, i) => {
    if (!hasLatLng(c.lat, c.lng)) return;
    const ll: L.LatLngTuple = [num(c.lat), num(c.lng)];
    pts.push(ll);
    L.marker(ll, { icon: pinIcon("#8a938d", String(i + 1)) }).bindTooltip(escapeHtml(c.name)).addTo(pinLayer!);
  });

  // 各日の予定 + 宿泊。ルートも順につなぐ
  const path: L.LatLngTuple[] = [];
  model.days.forEach((day, index) => {
    const pushPoint = (lat: string, lng: string, color: string, label: string, tip: string, marker = true): void => {
      if (!hasLatLng(lat, lng)) return;
      const ll: L.LatLngTuple = [num(lat), num(lng)];
      pts.push(ll); path.push(ll);
      if (marker) L.marker(ll, { icon: pinIcon(color, label) }).bindTooltip(escapeHtml(tip)).addTo(pinLayer!);
    };
    day.items.forEach((it) => {
      if (it.kind === "move") {
        pushPoint(it.fromLat, it.fromLng, KIND_COLOR.move, "発", it.from || "出発");
        pushPoint(it.toLat, it.toLng, KIND_COLOR.move, "着", it.to || "到着");
      } else {
        pushPoint(it.lat, it.lng, KIND_COLOR[it.kind], KINDS[it.kind].label.slice(0, 1), it.title || it.place || KINDS[it.kind].label);
      }
    });
    // 連泊は各夜の終点として経路に含め、ピンはチェックイン日だけ
    const cover = stayCovering(index);
    if (cover) pushPoint(cover.stay.lat, cover.stay.lng, KIND_COLOR.stay, "宿", cover.stay.title || "宿泊", cover.startIndex === index);
  });

  if (path.length >= 2) {
    L.polyline(path, { color: "#0b5a42", weight: 3, opacity: 0.55 }).addTo(routeLayer);
  }

  if (fit && pts.length) {
    map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 13 });
  }
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
  if (armedCity !== null) { void applyCityPin(armedCity, latlng.lat, latlng.lng); return; }
  if (!armed) return;
  const itemId = armed.itemId;
  const target = armed.target;
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
  armed = null;
  armedCity = null;
  mapHintEl.textContent = "";
  mapEl.style.cursor = "";
  daysEl.querySelectorAll(".pe-mini.is-armed").forEach((b) => b.classList.remove("is-armed"));
  clearCandidates();
}

function arm(itemId: number, target: GeoTarget, button: HTMLElement): void {
  if (armed && armed.itemId === itemId && armed.target === target) { disarm(); return; }
  disarm();
  armed = { itemId, target };
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
  if (armedCity === cityId) { disarm(); return; }
  disarm();
  armedCity = cityId;
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
    openItemId = openItemId === itemId ? null : itemId;
    disarm();
    renderDays();
    focusOpenItem();
    return;
  }
  if (act === "close") { openItemId = null; disarm(); renderDays(); return; }
  if (act === "remove") {
    const found = findItem(itemId);
    if (found) {
      if (found.item.kind === "stay") found.day.stay = null;
      else found.day.items = found.day.items.filter((x) => x.id !== itemId);
      markDirty(); renderDays(); refreshMap(false);
    }
    return;
  }
  if (act === "add") {
    const kind = (actEl.dataset.kind || "sight") as ItemKind;
    const day = model.days[dayIndex];
    if (!day) return;
    const it = newItem(kind);
    maybeDefaultMoveTransport(it, day, "", undefined, true);
    if (kind === "stay") day.stay = it;
    else day.items.push(it);
    openItemId = it.id;
    markDirty(); renderDays(); refreshMap(false); focusOpenItem();
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

let mapTimer = 0;
function scheduleMapRefresh(): void {
  window.clearTimeout(mapTimer);
  mapTimer = window.setTimeout(() => refreshMap(false), 500);
}

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

const coverInput = qs<HTMLInputElement>(root, "[data-cover-input]");
const coverClearBtn = qs<HTMLButtonElement>(root, "[data-cover-clear]");
const coverPreview = qs<HTMLElement>(root, "[data-cover-preview]");

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

const membersMount = qs<HTMLElement>(root, "[data-members]");
const memberField = qs<HTMLElement>(root, "[data-member-field]");
const memberSelect = qs<HTMLSelectElement>(root, "[data-member-select]");
const memberAddBtn = qs<HTMLButtonElement>(root, "[data-member-add]");
const memberHint = qs<HTMLElement>(root, "[data-member-hint]");

function hasMemberAccount(): boolean {
  return Boolean(currentAccount());
}

function memberArray(): string[] { return splitNames(model.members); }
function setMembers(ids: string[]): void {
  model.memberIds = [...new Set(ids.filter(Boolean))];
  model.members = model.memberIds.map((id) => db.nameOf(id)).filter(Boolean).join("、");
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

function renderMembers(): void {
  const account = currentAccount();
  const me = account?.name || "";
  const arr = memberArray();
  const meta = slug ? TripPlans.get(slug) : null;
  const stored = meta ? db.planBySlug(meta.slug) : null;
  const ownerId = stored?.owner_user_id || account?.id || "";
  const memberAccounts = model.memberIds.map((id) => ({ id, name: db.nameOf(id) })).filter((member) => member.name);
  const displayMembers = memberAccounts.length
    ? memberAccounts
    : arr.map((name) => ({ id: listFriends().find((friend) => friend.name === name)?.id || "", name }));
  membersMount.innerHTML = displayMembers
    .map((member) => {
      const self = account?.id ? member.id === account.id : Boolean(me) && member.name === me;
      return (
        `<span class="pe-chip-m${self ? " is-self" : ""}">` +
        `<span>${escapeHtml(member.name)}</span>` +
        (self ? `<span class="pe-chip-self">自分</span>` : "") +
        (member.id === ownerId ? `<span class="pe-chip-self">Owner</span>` : "") +
        (meta && canManagePlan(meta) && member.id && !self && member.id !== ownerId
          ? `<button class="pe-chip-ic" type="button" data-transfer-owner="${escapeHtml(member.id)}" data-transfer-name="${escapeHtml(member.name)}" title="所有権を移譲" aria-label="${escapeHtml(member.name)}へ所有権を移譲">${icon("arrowsRightLeft")}</button>`
          : "") +
        (!account || self
          ? ""
          : `<button class="pe-chip-ic invite" type="button" data-invite="${escapeHtml(member.name)}" data-invite-user="${escapeHtml(member.id)}" title="招待リンクを送る" aria-label="${escapeHtml(member.name)}を招待">${icon("paperAirplane")}</button>`) +
        (member.id && member.id !== ownerId
          ? `<button class="pe-chip-ic del" type="button" data-rm="${escapeHtml(member.id)}" title="削除" aria-label="${escapeHtml(member.name)}を削除">${icon("xMark")}</button>`
          : "") +
        `</span>`
      );
    })
    .join("");
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
  memberHint.hidden = candidates.length > 0;
}

function updateMemberVisibility(): void {
  const meta = slug ? TripPlans.get(slug) : null;
  const enabled = hasMemberAccount() && (!meta || canManagePlan(meta));
  memberField.hidden = !enabled;
  memberField.classList.toggle("is-enabled", enabled);
}

function updateWorkspaceControlVisibility(): void {
  const meta = slug ? TripPlans.get(slug) : null;
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
  const transfer = t.closest<HTMLElement>("[data-transfer-owner]");
  if (transfer) {
    void transferOwnership(transfer.dataset.transferOwner || "", transfer.dataset.transferName || "");
    return;
  }
  const inv = t.closest<HTMLElement>("[data-invite]");
  if (inv) { void shareInvite(inv.dataset.invite || "", inv.dataset.inviteUser || ""); }
});

async function transferOwnership(userId: string, name: string): Promise<void> {
  const meta = slug ? TripPlans.get(slug) : null;
  const planId = meta?.id || (slug ? TripPlans.planIdOf(slug) : "");
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

function toast(message: string): void {
  const el = document.createElement("div");
  el.className = "pe-toast";
  el.textContent = message;
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 3200);
}

// ---- 行きたい候補（投票ボード） ----------------------------------------

const candMount = qs<HTMLElement>(root, "[data-candidates]");
const candInput = qs<HTMLInputElement>(root, "[data-cand-input]");
const candCountEl = qs<HTMLElement>(root, "[data-cand-count]");

function candId(): string {
  return "cand_" + seq++ + "_" + Math.random().toString(36).slice(2, 6);
}

/** 票数の多い順（同数は作成順）に並べる。 */
function sortedCandidates(): Candidate[] {
  return model.candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.votes?.length || 0) - (a.c.votes?.length || 0) || a.i - b.i)
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
  const list = sortedCandidates();
  candCountEl.textContent = list.length ? `${list.length}件` : "";
  if (!list.length) {
    candMount.innerHTML = "";
    return;
  }
  const canAdopt = model.days.length > 0;
  candMount.innerHTML = list
    .map((c) => {
      const voted = Boolean(me) && (c.votes || []).includes(me);
      const n = (c.votes || []).length;
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
  model.candidates.push({
    id: candId(),
    title: t,
    votes: me ? [me] : [],
    proposer: me || undefined,
    createdAt: new Date().toISOString(),
  });
  markDirty();
  renderCandidates();
}

function toggleVote(id: string): void {
  const me = getUser().name.trim();
  if (!me) {
    toast("マイページで名前を登録すると投票できます");
    return;
  }
  const c = model.candidates.find((x) => x.id === id);
  if (!c) return;
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
qs<HTMLButtonElement>(root, "[data-cand-add]").addEventListener("click", commitCandInput);
candInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitCandInput();
  }
});

async function shareInvite(name: string, userId = ""): Promise<void> {
  if (editorLocked) return;
  if (!model.title.trim()) { toast("先に旅行名を入力してください"); return; }
  if (!slug) { slug = TripPlans.uniqueSlug(model.title); model.slug = slug; }
  if (!(await persist(true))) {
    toast("計画を保存できなかったため、招待を作成しませんでした");
    return;
  }
  const data = buildData();
  const meta = TripPlans.get(slug);
  if (meta && !canManagePlan(meta)) { toast("招待できるのは計画の所有者だけです"); return; }
  const planId = TripPlans.planIdOf(slug);
  if (!planId) { toast("保存してから招待してください"); return; }
  const invite = await db.createInvite(planId, {
    invited_name: name, invited_user_id: userId || undefined, role: "editor",
  });
  const link = await buildInviteLink({
    v: 1,
    meta: {
      slug,
      title: model.title,
      dates: datesString(),
      members: model.members,
      route: (data.cities || []).map((c) => c.name).filter(Boolean).join("→"),
      updatedAt: TripPlans.get(slug)?.updatedAt,
    },
    token: invite.token,
    invitedName: name,
    role: "editor",
  });
  const shareData = {
    title: model.title || "旅行計画",
    text: `「${model.title || "旅行"}」に${name ? `${name}さんを` : ""}招待します`,
    url: link,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch { return; /* キャンセル */ }
  }
  try { await navigator.clipboard.writeText(link); toast("招待リンクをコピーしました"); }
  catch { window.prompt("招待リンクをコピーしてください", link); }
}

// ---- カレンダー連携（Google テンプレート / .ics） ----------------------

const gcalBtn = qs<HTMLButtonElement>(root, "[data-gcal]");
const icsBtn = qs<HTMLButtonElement>(root, "[data-ics]");

function fmtMd(iso: string): string {
  const d = parseISO(iso);
  return d ? `${d.getMonth() + 1}/${d.getDate()}` : "";
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

cityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); void addCity(cityInput.value); cityInput.value = ""; }
});
qs<HTMLButtonElement>(root, "[data-city-add]").addEventListener("click", () => {
  void addCity(cityInput.value); cityInput.value = "";
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
  qs<HTMLInputElement>(root!, '[data-f="title"]').value = model.title || "";
  qs<HTMLInputElement>(root!, '[data-f="note"]').value = model.note || "";
  updateCoverPreview();
  updateMemberVisibility();
  renderMembers();
  renderMemberSelect();
  if (model.startDate && model.endDate) fp.setDate([model.startDate, model.endDate], false);
  updateRangeButton();
  titleEcho.textContent = model.title || "新しい計画";
  updateCalsync();
}

function coordOut(s: string): number | "" {
  return s.trim() !== "" && !isNaN(num(s)) ? num(s) : "";
}

function buildData(): LocalPlanData {
  const itinerary: ItineraryItem[] = [];
  model.days.forEach((day, di) => {
    const dayLabel = `Day ${di + 1}`;
    const city = cityForDate(day.date);
    const dayArea = city?.name || day.area || "";
    const flush = (it: Item): void => {
      const base: ItineraryItem = {
        date: day.date, day: dayLabel, area: dayArea || it.place || "",
        time: it.time || "", type: it.kind as ItemType, typeLabel: KINDS[it.kind].label,
        title: it.title || (it.kind === "move" ? `${it.from} → ${it.to}` : ""),
        place: it.place || (it.kind === "move" ? it.to : ""),
        note: [it.note, it.kind === "move" ? [it.transport, it.duration].filter(Boolean).join(" ") : ""].filter(Boolean).join(" / "),
        lat: it.kind === "move" ? "" : coordOut(it.lat),
        lng: it.kind === "move" ? "" : coordOut(it.lng),
        mapQuery: it.mapQuery || it.place || "",
        weather: "",
      };
      if (it.kind === "move") {
        base.origin = it.from; base.destination = it.to;
        const fl = coordOut(it.fromLat), fn = coordOut(it.fromLng);
        const tl = coordOut(it.toLat), tn = coordOut(it.toLng);
        if (typeof fl === "number") base.originLat = fl;
        if (typeof fn === "number") base.originLng = fn;
        if (typeof tl === "number") base.destinationLat = tl;
        if (typeof tn === "number") base.destinationLng = tn;
        if (typeof tl === "number" && typeof tn === "number") { base.lat = tl; base.lng = tn; }
      }
      itinerary.push(base);
    };
    day.items.forEach(flush);
    // 連泊は各夜に1行ずつ出す（ダッシュボードで毎晩の宿が地図に出る）
    const cover = stayCovering(di);
    if (cover) flush(cover.stay);
  });
  return {
    trip: { title: model.title || "無題の旅行", dates: datesString(), members: model.members || "", note: model.note || "", cover: model.cover || "" },
    itinerary,
    links: [],
    checklist: [],
    cities: model.cities.map((c) => ({
      name: c.name,
      fromDate: c.fromDate,
      toDate: c.toDate,
      lat: coordOut(c.lat),
      lng: coordOut(c.lng),
    })),
    candidates: model.candidates,
  };
}

function loadExisting(): boolean {
  const meta = slug ? TripPlans.get(slug) : null;
  if (meta && meta.source && meta.source !== "local") {
    return lockEditor("この計画は外部連携のため、ここでは編集できません");
  }
  // 持ち主が居ない計画（権限行もメンバー名も無い）は、名前未設定の本人まで締め出さない。
  // ダッシュボードの computeReadOnly と同じ判定に揃えている。
  if (meta && planHasOwner(meta) && !canEditPlan(meta)) {
    return lockEditor("この計画を編集する権限がありません");
  }
  const data = slug ? TripPlans.getData(slug) : null;
  if (!data) return true;
  const trip = data.trip || { title: "", dates: "", members: "", note: "" };
  model.title = trip.title || "";
  model.members = trip.members || "";
  model.memberIds = meta?.memberIds ? [...meta.memberIds] : [];
  model.note = trip.note || "";
  model.cover = trip.cover || "";
  model.candidates = Array.isArray(data.candidates) ? data.candidates : [];
  model.visibility = meta?.visibility;
  const parts = String(trip.dates || "").split(/\s+-\s+/);
  model.startDate = normalizeToISO(parts[0]);
  model.endDate = normalizeToISO(parts[1] || parts[0]);

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
    });
    if (kind === "stay") day.stay = it;
    else day.items.push(it);
  });
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
    model.cities = data.cities.map((c) => ({
      id: seq++, name: c.name || "",
      fromDate: c.fromDate || "", toDate: c.toDate || "",
      lat: c.lat != null ? String(c.lat) : "", lng: c.lng != null ? String(c.lng) : "",
    }));
  } else {
    // 旧データ：行程の area から都市名だけ拾う（期間は空）
    model.cities = Array.from(cityNames).map((name) => {
      const hit = TripPlans.coordsFor(name);
      return { id: seq++, name, lat: hit ? String(hit.lat) : "", lng: hit ? String(hit.lng) : "", fromDate: "", toDate: "" };
    });
  }
  return true;
}

function normalizeKind(type: string | undefined): ItemKind {
  const t = String(type || "");
  return (["sight", "food", "move", "stay", "todo", "form"] as ItemKind[]).includes(t as ItemKind) ? (t as ItemKind) : "sight";
}

async function save(): Promise<void> {
  if (editorLocked) {
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
  if (field === "title") qs<HTMLInputElement>(root!, '[data-f="title"]').focus();
  else if (field === "dates") rangeTrigger.focus();
  else cityInput.focus();
}

function publish(): void {
  if (editorLocked) return;
  const meta = slug ? TripPlans.get(slug) : null;
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
  if (editorLocked) return;
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
  if (!TripPlans.upsert({ slug, visibility, published: true })) {
    statusEl.textContent = "ログインしてから保存してください";
    statusEl.className = "is-dirty";
    setSaveActionsBusy(false);
    return;
  }
  TripPlans.setActiveSlug(slug);
  try {
    await db.flushMutations(mutationCheckpoint);
  } catch (error) {
    dirty = true;
    statusEl.textContent = "保存できませんでした";
    statusEl.className = "is-dirty";
    savebarNoteEl.textContent = errorMessage(error);
    setSaveActionsBusy(false);
    return;
  }
  dirty = false;
  const visLabel = visibility === "invite" ? "招待制" : "公開";
  statusEl.textContent = `保存しました（${visLabel}）`;
  statusEl.className = "is-ok";
  openLink.href = "index.html?plan=" + encodeURIComponent(slug);
  openLink.hidden = false;
  savebarNoteEl.textContent = `保存しました（${visLabel}）。右上の「表示」でダッシュボードを確認できます。`;
  try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(slug)); } catch { /* ignore */ }
  setSaveActionsBusy(false);
  navigateWithPageTransition("index.html?plan=" + encodeURIComponent(slug));
}

async function doUnpublish(): Promise<void> {
  if (!slug || editorLocked) return;
  setSaveActionsBusy(true);
  const mutationCheckpoint = db.mutationCheckpoint();
  if (!TripPlans.upsert({ slug, published: false })) {
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
  const meta = slug ? TripPlans.get(slug) : null;
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
openLink.innerHTML = icon("eye");
const saveBtn = qs<HTMLButtonElement>(root, "[data-save]");
const publishBtn = qs<HTMLButtonElement>(root, "[data-publish-plan]");
const stepNextBtn = qs<HTMLButtonElement>(root, "[data-step-next]");
function setSaveActionsBusy(busy: boolean): void {
  saveActionsBusy = busy;
  saveBtn.disabled = busy;
  publishBtn.disabled = busy;
  stepNextBtn.disabled = busy || (viewStep < 3 && !stepCompletion()[viewStep - 1]);
  saveBtn.innerHTML = busy ? icon("arrowPath") + "<span>保存中…</span>" : icon("bookmark") + "<span>下書きを保存</span>";
}
saveBtn.innerHTML = icon("bookmark") + "<span>下書きを保存</span>";
publishBtn.innerHTML = icon("globeAlt") + "<span>公開設定</span>";
saveBtn.addEventListener("click", () => { void save(); });
publishBtn.addEventListener("click", publish);
qs<HTMLButtonElement>(root, "[data-city-add]").innerHTML = icon("plus") + "<span>追加</span>";
const localNoteEl = qs<HTMLElement>(root, "[data-local-note]");
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
const exportBtn = qs<HTMLButtonElement>(root, "[data-export]");
exportBtn.innerHTML = icon("documentText") + "<span>書き出し</span>";
exportBtn.addEventListener("click", exportJson);

// 地図の表示/非表示
const mapToggle = qs<HTMLButtonElement>(root, "[data-map-toggle]");
const mapShow = qs<HTMLButtonElement>(root, "[data-map-show]");
const mapClose = qs<HTMLButtonElement>(root, "[data-map-close]");
mapShow.innerHTML = icon("map") + "<span>地図を表示</span>";
mapClose.innerHTML = icon("xMark");
function setMapCollapsed(collapsed: boolean): void {
  root!.classList.toggle("map-collapsed", collapsed);
  mapShow.hidden = !collapsed;
  mapToggle.textContent = collapsed ? "地図を表示" : "地図を隠す";
  try { localStorage.setItem("pe-map-collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  if (!collapsed) window.setTimeout(() => { if (map) { map.invalidateSize(); refreshMap(true); } }, 60);
}
mapToggle.addEventListener("click", () => setMapCollapsed(!root!.classList.contains("map-collapsed")));
mapShow.addEventListener("click", () => setMapCollapsed(false));
mapClose.addEventListener("pointerdown", (event) => event.stopPropagation());
mapClose.addEventListener("click", (event) => { event.stopPropagation(); setMapCollapsed(true); });

// スマホ: 地図ボトムシートの境界をドラッグして高さを変更
const mapGrip = root!.querySelector<HTMLElement>("[data-map-grip]");
const mapWrapEl = root!.querySelector<HTMLElement>(".pe-mapwrap");
if (mapGrip && mapWrapEl) {
  const MIN_MAP_H = 180;
  const maxMapH = (): number => Math.round(window.innerHeight * 0.92);
  let resizeRaf = 0;
  let dragging = false;
  const applyMapHeight = (height: number, persist = true): void => {
    const h = Math.max(MIN_MAP_H, Math.min(maxMapH(), Math.round(height)));
    root!.style.setProperty("--pe-map-h", `${h}px`);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { if (map) map.invalidateSize({ animate: false }); });
    if (persist) { try { localStorage.setItem("pe-map-h", String(h)); } catch { /* ignore */ } }
  };
  mapGrip.addEventListener("pointerdown", (e) => {
    dragging = true;
    root!.classList.add("is-map-resizing");
    try { mapGrip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  mapGrip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    applyMapHeight(window.innerHeight - e.clientY);
  });
  const endMapDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    root!.classList.remove("is-map-resizing");
    try { mapGrip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (map) map.invalidateSize();
  };
  mapGrip.addEventListener("pointerup", endMapDrag);
  mapGrip.addEventListener("pointercancel", endMapDrag);
  mapGrip.addEventListener("keydown", (e) => {
    const cur = mapWrapEl.getBoundingClientRect().height;
    if (e.key === "ArrowUp") { applyMapHeight(cur + 24); e.preventDefault(); }
    else if (e.key === "ArrowDown") { applyMapHeight(cur - 24); e.preventDefault(); }
  });
  try {
    const saved = Number(localStorage.getItem("pe-map-h"));
    if (saved && saved >= MIN_MAP_H) applyMapHeight(saved, false);
  } catch { /* ignore */ }
}

// 行のキーボード操作（Enter/Space で開閉）
function focusOpenItem(): void {
  if (openItemId == null) return;
  const node = daysEl.querySelector<HTMLElement>(`[data-node="${openItemId}"]`);
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
    openItemId = openItemId === id ? null : id;
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
  if (editorLocked) return;
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});

// タブが背面へ移る時は、beforeunload の非同期処理に頼らず先に保存を開始する。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && dirty && worthSaving()) void persist();
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
  if (slug) { openLink.href = "index.html?plan=" + encodeURIComponent(slug); openLink.hidden = false; }
  syncBasicInputs();
  rebuildDays();
  lastSavedContentFingerprint = contentFingerprint(buildData());
  renderCities();
  renderDays();
  renderCandidates();
  initMap();
  refreshMap(true);
  // 地図の初期表示：スマホは入力を優先し、地図は必要な時だけ開く。
  const savedMapPref = localStorage.getItem("pe-map-collapsed");
  if (window.matchMedia("(max-width: 680px)").matches) {
    setMapCollapsed(true);
  } else if (savedMapPref === "1" || (savedMapPref == null && window.matchMedia("(max-width: 760px)").matches)) {
    setMapCollapsed(true);
  }
  statusEl.textContent = isNew ? "下書き（自動保存・未保存）" : editable ? "読み込み完了" : statusEl.textContent;
  const meta = slug ? TripPlans.get(slug) : null;
  publishBtn.hidden = Boolean(meta && !canManagePlan(meta));
  if (!editable || editorLocked) applyEditorLock();
}

// 編集画面は控え（キャッシュ）を使わずサーバーの最新を待つ。
// 裏で snap が差し替わると、編集中の内容と食い違うため。
void db.load({ fresh: true, strict: db.isEnabled() }).then(bootstrapEditor).catch((error) => {
  lockEditor("旅行データを読み込めませんでした。接続を確認して再読み込みしてください");
  savebarNoteEl.textContent = errorMessage(error);
  applyEditorLock();
});

registerServiceWorker();
