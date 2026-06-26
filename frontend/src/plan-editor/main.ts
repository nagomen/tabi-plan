// 旅行計画エディタ（フル刷新版）。
// 設計方針:
//  - 2段階: まず骨組み（旅行名・期間・メンバー・ルート都市）→ 各日を後から肉付け。
//  - 種別ごとに表示を最適化: 移動=区間 / 宿泊=その日の錨 / 観光・食事=タイムライン。
//  - 折りたたみ行（タップで編集）＋ クイック追加 ＋ 編集内ライブ地図（ピン+ルート, Nominatim）。
//  - 保存時は従来の LocalPlanData.itinerary（ItineraryItem[]）へフラット化し、ダッシュボード互換。

import L from "leaflet";
import "../shared/ui.css";
import "leaflet/dist/leaflet.css";
import flatpickr from "flatpickr";
import { Japanese } from "flatpickr/dist/l10n/ja.js";
import "flatpickr/dist/flatpickr.css";
import Sortable from "sortablejs";

import * as TripPlans from "../shared/plans-store";
import type { LocalPlanData } from "../shared/plans-store";
import type { ItineraryItem, ItemType } from "../shared/types";
import { readGlobalTripConfig } from "../shared/config";
import { escapeHtml } from "../shared/dom";
import { icon, type IconName } from "../shared/icons";
import { registerServiceWorker } from "../shared/pwa";

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

interface Model {
  slug: string;
  title: string;
  members: string;
  note: string;
  startDate: string;
  endDate: string;
  cities: City[];
  days: Day[];
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

// ---- DOM ----------------------------------------------------------------

function qs<E extends Element = HTMLElement>(parent: ParentNode, selector: string): E {
  const el = parent.querySelector<E>(selector);
  if (!el) throw new Error(`要素が見つかりません: ${selector}`);
  return el;
}

const root = document.getElementById("editor");
if (!root) throw new Error("エディタのルート要素が見つかりません: #editor");

const daysEl = qs<HTMLElement>(root, "[data-days]");
const statusEl = qs<HTMLElement>(root, "[data-status]");
const titleEcho = qs<HTMLElement>(root, "[data-title-echo]");
const openLink = qs<HTMLAnchorElement>(root, "[data-open]");
const warnEl = qs<HTMLElement>(root, "[data-daterange-warn]");
const dayCountEl = qs<HTMLElement>(root, "[data-day-count]");
const savebarNoteEl = qs<HTMLElement>(root, "[data-savebar-note]");
const citiesEl = qs<HTMLElement>(root, "[data-cities]");
const cityInput = qs<HTMLInputElement>(root, "[data-city-input]");
const cityOptions = qs<HTMLDataListElement>(document, "#pe-city-options");
const mapEl = qs<HTMLElement>(root, "[data-map]");
const mapHintEl = qs<HTMLElement>(root, "[data-map-hint]");
const rangeEl = qs<HTMLInputElement>(root, "[data-range]");
const dayStripEl = qs<HTMLElement>(root, "[data-daystrip]");
const tripSummaryEl = qs<HTMLElement>(root, "[data-trip-summary]");

// セクション見出しにアイコン
qs<HTMLElement>(root, "[data-ic-setup]").insertAdjacentHTML("afterbegin", icon("sparkles") + " ");
qs<HTMLElement>(root, "[data-ic-route]").insertAdjacentHTML("afterbegin", icon("map") + " ");
qs<HTMLElement>(root, "[data-ic-days]").insertAdjacentHTML("afterbegin", icon("calendarDays") + " ");

// ---- 初期状態 -----------------------------------------------------------

const params = new URLSearchParams(location.search);
const planParam = (params.get("plan") || "").trim();
const isNew = !planParam;
let slug = isNew ? "" : TripPlans.safeSlug(planParam);

const model: Model = {
  slug, title: "", members: "", note: "", startDate: "", endDate: "", cities: [], days: [],
};
let dirty = false;
let seq = 1;
let openItemId: number | null = null;
let armed: { itemId: number; target: GeoTarget } | null = null;

// 期間レンジピッカー（flatpickr・カレンダーで開始日→終了日を一括選択）
const fp = flatpickr(rangeEl, {
  mode: "range",
  dateFormat: "Y-m-d",
  locale: Japanese,
  onChange: (dates: Date[]) => {
    model.startDate = dates[0] ? toISO(dates[0]) : "";
    model.endDate = dates[1] ? toISO(dates[1]) : model.startDate;
    rebuildDays();
    renderDays();
    refreshMap(false);
    markDirty();
  },
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

function latLngKeys(target: GeoTarget): [ItemStrKey, ItemStrKey] {
  if (target === "from") return ["fromLat", "fromLng"];
  if (target === "to") return ["toLat", "toLng"];
  return ["lat", "lng"];
}

interface GeoResult { label: string; lat: number; lng: number; }

// Mapbox トークンがあれば Mapbox（多言語POIに強い）、無ければ Nominatim を使う。
const MAPBOX_TOKEN = readGlobalTripConfig().geocoding?.mapboxToken || "";

let lastGeoAt = 0;
async function geocodeSearch(query: string): Promise<GeoResult[]> {
  if (MAPBOX_TOKEN) return geocodeMapbox(query);
  // Nominatim は規約順守のため最短 1.1 秒間隔
  const wait = 1100 - (Date.now() - lastGeoAt);
  if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
  lastGeoAt = Date.now();
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=5&accept-language=ja&q=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("検索に失敗しました (" + res.status + ")");
  const data = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
  return data
    .map((d) => ({ label: String(d.display_name || ""), lat: Number(d.lat), lng: Number(d.lon) }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

interface MapboxFeature {
  properties?: { name?: string; name_preferred?: string; place_formatted?: string; full_address?: string };
  geometry?: { coordinates?: [number, number] };
}

// Mapbox Search Box API（POI/施設名・多言語に強い）。
async function geocodeMapbox(query: string): Promise<GeoResult[]> {
  const url =
    "https://api.mapbox.com/search/searchbox/v1/forward?q=" + encodeURIComponent(query) +
    "&language=ja&limit=5&access_token=" + encodeURIComponent(MAPBOX_TOKEN);
  const res = await fetch(url);
  if (!res.ok) throw new Error("検索に失敗しました (" + res.status + ")");
  const data = (await res.json()) as { features?: MapboxFeature[] };
  return (data.features || [])
    .map((f) => {
      const coord = f.geometry && f.geometry.coordinates;
      const name = (f.properties && (f.properties.name_preferred || f.properties.name)) || "";
      const area = (f.properties && (f.properties.place_formatted || f.properties.full_address)) || "";
      return {
        label: [name, area].filter(Boolean).join(" / "),
        lat: coord ? coord[1] : NaN,
        lng: coord ? coord[0] : NaN,
      };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
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

let persistTimer = 0;
function markDirty(): void {
  dirty = true;
  if (model.title.trim()) {
    statusEl.textContent = "編集中…";
    statusEl.className = "is-dirty";
  } else {
    statusEl.textContent = "旅行名を入れると自動保存されます";
    statusEl.className = "is-dirty";
  }
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persist, 700);
}

function nowHM(): string {
  const d = new Date();
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

// 自動保存（localStorage）。旅行名があれば slug を採番して保存する。
function persist(): void {
  if (!model.title.trim()) return;
  if (!slug) {
    slug = TripPlans.uniqueSlug(model.title);
    model.slug = slug;
    openLink.href = "index.html?plan=" + encodeURIComponent(slug);
    openLink.hidden = false;
    try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(slug)); } catch { /* ignore */ }
  }
  TripPlans.saveLocalPlan(slug, buildData());
  TripPlans.setActiveSlug(slug);
  dirty = false;
  statusEl.textContent = `自動保存しました ${nowHM()}`;
  statusEl.className = "is-ok";
  savebarNoteEl.textContent = "";
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

function renderCities(): void {
  cityOptions.innerHTML = model.cities.map((c) => `<option value="${escapeHtml(c.name)}">`).join("");
  if (!model.cities.length) {
    citiesEl.innerHTML = `<span class="pe-route-empty">まだありません。行きたい都市を足すと地図に出ます。期間を入れると「いつ滞在するか」も割り当てられます。</span>`;
    return;
  }
  const hasDays = model.days.length > 0;
  citiesEl.innerHTML = model.cities
    .map((c, i) => {
      const noGeo = hasLatLng(c.lat, c.lng) ? "" : " no-geo";
      const dateCtl = hasDays
        ? `<span class="pe-city-dates">` +
          `<select data-city-from="${c.id}" aria-label="開始日">${dayOptions(c.fromDate)}</select>` +
          `<span class="pe-city-sep">〜</span>` +
          `<select data-city-to="${c.id}" aria-label="終了日">${dayOptions(c.toDate)}</select>` +
          `</span>`
        : "";
      return `<div class="pe-city${noGeo}" data-city="${c.id}">` +
        `<span class="pe-city-n">${i + 1}</span>` +
        `<span class="pe-city-name">${escapeHtml(c.name)}</span>` +
        dateCtl +
        `<button type="button" data-act="city-del" data-city="${c.id}" aria-label="削除">${icon("xMark")}</button>` +
        `</div>`;
    })
    .join("");
}

async function addCity(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  const local = TripPlans.coordsFor(trimmed);
  const city: City = { id: seq++, name: trimmed, lat: local ? String(local.lat) : "", lng: local ? String(local.lng) : "", fromDate: "", toDate: "" };
  model.cities.push(city);
  markDirty();
  renderCities();
  refreshMap(false);
  if (!local) {
    try {
      const res = await geocodeSearch(trimmed);
      if (res[0]) { city.lat = String(res[0].lat); city.lng = String(res[0].lng); renderCities(); refreshMap(true); }
    } catch { /* best-effort */ }
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
  const area = day.area || (city ? city.name : "") || (cover && cover.stay.title ? cover.stay.title : "") || "エリア未設定";
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
    const mid = [item.transport, item.duration].filter(Boolean).join(" ");
    return (
      `<span class="pe-chip" data-kind="move">${icon(k.icon)}${k.label}</span>` +
      `<span class="pe-row-time">${escapeHtml(item.time)}</span>` +
      `<span class="pe-seg"><span class="ep">${escapeHtml(from)}</span>` +
      `<span class="arr">${icon("arrowLongRight")}</span>` +
      (mid ? `<span class="mid">${escapeHtml(mid)}</span>` : "") +
      `<span class="arr">${icon("arrowLongRight")}</span>` +
      `<span class="ep">${escapeHtml(to)}</span></span>` +
      `<span class="pe-row-caret">${icon("chevronDown")}</span>`
    );
  }
  const title = item.title || item.place;
  const titleCls = title ? "" : " is-empty";
  const titleText = title || "（タイトル未入力）";
  const sub = item.place && item.title ? ` <small>${escapeHtml(item.place)}</small>` : "";
  return (
    `<span class="pe-chip" data-kind="${item.kind}">${icon(k.icon)}${k.label}</span>` +
    `<span class="pe-row-time">${escapeHtml(item.time)}</span>` +
    `<span class="pe-row-title${titleCls}">${escapeHtml(titleText)}${sub}</span>` +
    `<span class="pe-row-caret">${icon("chevronDown")}</span>`
  );
}

function fieldInput(item: Item, key: ItemStrKey, ph: string): string {
  return `<input data-field="${key}" data-item="${item.id}" value="${escapeHtml(item[key])}" placeholder="${escapeHtml(ph)}">`;
}

function placeBlock(item: Item, target: GeoTarget, label: string, ph: string): string {
  const key: ItemStrKey = target === "from" ? "from" : target === "to" ? "to" : "place";
  return (
    `<div class="pe-field c2"><span>${label}</span>` +
    fieldInput(item, key, ph) +
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
  const end = `</div><div class="pe-edit-actions"><button class="pe-mini" type="button" data-act="close">${icon("check")}<span>閉じる</span></button></div>`;
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
  const nightsSelect = item.kind === "stay"
    ? `<label class="pe-field"><span>泊数</span><select data-field="nights" data-item="${item.id}">` +
      Array.from({ length: Math.max(model.days.length, 1) }, (_, i) => i + 1)
        .map((n) => `<option value="${n}"${item.nights === n ? " selected" : ""}>${n}泊</option>`).join("") +
      `</select></label>`
    : "";
  return (
    g +
    `<label class="pe-field c2"><span>タイトル</span>${fieldInput(item, "title", item.kind === "stay" ? "例: 八戸グランドホテル" : item.kind === "food" ? "例: 夕食 / 海鮮丼" : "例: 中尊寺を拝観")}</label>` +
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
    `<span class="pe-grip" data-grip aria-label="ドラッグで並べ替え">${icon("bars3")}</span>` +
    rowSummary(item) +
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
  const title = stay.title || "宿泊先 未入力";
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
  renderDayStrip();
  dayCountEl.textContent = model.days.length ? `全${model.days.length}日` : "";
  if (!model.days.length) {
    daysEl.innerHTML =
      `<div class="pe-empty-cta"><b>まずは期間を選びましょう</b>` +
      `<span>上の「開始日」と「終了日」を入れると、日ごとの予定欄がここに出ます。</span></div>`;
    return;
  }
  daysEl.innerHTML = model.days
    .map((day, index) => {
      const items = day.items.map(timelineNode).join("");
      const empty = day.items.length ? "" : `<p class="pe-day-empty">まだ予定がありません。下のボタンから追加するか、上の日から予定をドラッグできます。</p>`;
      // 前夜の宿を朝に出発するときだけ「前泊から出発」を出す（連泊中は出さない）
      const coverPrev = index > 0 ? stayCovering(index - 1) : null;
      const coverToday = stayCovering(index);
      const leftHotel = coverPrev && (!coverToday || coverToday.stay.id !== coverPrev.stay.id);
      const startBanner = leftHotel && coverPrev.stay.title
        ? `<div class="pe-start"><span class="pe-start-ic">${icon("buildingOffice2")}</span>` +
          `<div class="pe-start-main"><b>前泊から出発</b><br><span>${escapeHtml(coverPrev.stay.title)}</span></div></div>`
        : "";
      // 都市バンド（ルート都市の滞在範囲が変わる初日に挿入）
      const city = cityForDate(day.date);
      const prevCity = index > 0 ? cityForDate(model.days[index - 1].date) : null;
      const band = city && city.id !== (prevCity ? prevCity.id : -1)
        ? `<div class="pe-cityband">${icon("mapPin")}<b>${escapeHtml(city.name)}</b><span>${cityRangeLabel(city)}</span></div>`
        : "";
      const areaPlaceholder = city ? city.name : "例: 盛岡";
      return (
        band +
        `<article class="pe-day" data-day="${index}">` +
        dayHeader(day, index) +
        `<div class="pe-day-body">` +
        `<label class="pe-field" style="margin-bottom:10px;"><span>この日の拠点エリア <em>${city ? "都市から自動・上書き可" : "任意"}</em></span>` +
        `<input data-area="${index}" list="pe-city-options" value="${escapeHtml(day.area)}" placeholder="${escapeHtml(areaPlaceholder)}"></label>` +
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
      const title = item.title || "宿泊先 未入力";
      const meta = [item.time ? `IN ${item.time}` : "", item.place].filter(Boolean).join(" ・ ");
      main.innerHTML = `<b class="${item.title ? "" : "is-empty"}">${escapeHtml(title)}</b><span>${escapeHtml(meta || "この日の宿泊先")}</span>`;
    }
  } else {
    const row = node.querySelector<HTMLElement>(".pe-row");
    if (row) row.innerHTML = rowSummary(item);
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

function initMap(): void {
  map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([39.6, 140.6], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap",
  }).addTo(map);
  pinLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
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
    L.marker(ll, { icon: pinIcon("#8a938d", String(i + 1)) }).bindTooltip(c.name).addTo(pinLayer!);
  });

  // 各日の予定 + 宿泊。ルートも順につなぐ
  const path: L.LatLngTuple[] = [];
  model.days.forEach((day, index) => {
    const pushPoint = (lat: string, lng: string, color: string, label: string, tip: string, marker = true): void => {
      if (!hasLatLng(lat, lng)) return;
      const ll: L.LatLngTuple = [num(lat), num(lng)];
      pts.push(ll); path.push(ll);
      if (marker) L.marker(ll, { icon: pinIcon(color, label) }).bindTooltip(tip).addTo(pinLayer!);
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

function onMapClick(latlng: L.LatLng): void {
  if (!armed) return;
  const found = findItem(armed.itemId);
  if (!found) return;
  const [latKey, lngKey] = latLngKeys(armed.target);
  found.item[latKey] = latlng.lat.toFixed(6);
  found.item[lngKey] = latlng.lng.toFixed(6);
  setGeoStatus(armed.itemId, armed.target, "地図で位置を指定しました", "ok");
  disarm();
  markDirty();
  refreshMap(false);
}

function disarm(): void {
  armed = null;
  mapHintEl.textContent = "";
  mapEl.style.cursor = "";
  daysEl.querySelectorAll(".pe-mini.is-armed").forEach((b) => b.classList.remove("is-armed"));
}

function arm(itemId: number, target: GeoTarget, button: HTMLElement): void {
  if (armed && armed.itemId === itemId && armed.target === target) { disarm(); return; }
  disarm();
  armed = { itemId, target };
  mapHintEl.textContent = "地図をクリックして位置を指定";
  mapEl.style.cursor = "crosshair";
  button.classList.add("is-armed");
}

// ---- ジオコーディング状態表示 -------------------------------------------

function setGeoStatus(itemId: number, target: GeoTarget, text: string, kind?: "ok" | "warn"): void {
  const el = daysEl.querySelector<HTMLElement>(`[data-geo="${itemId}-${target}"]`);
  if (!el) return;
  const mark = kind === "ok" ? icon("checkCircle") : kind === "warn" ? icon("exclamationTriangle") : "";
  el.innerHTML = mark + "<span>" + escapeHtml(text) + "</span>";
  el.className = "pe-geo-status" + (kind ? " is-" + kind : "");
}

async function runGeocode(itemId: number, target: GeoTarget): Promise<void> {
  const found = findItem(itemId);
  if (!found) return;
  const item = found.item;
  const query = (target === "from" ? item.from : target === "to" ? item.to : (item.mapQuery || item.place)).trim();
  const resultsEl = daysEl.querySelector<HTMLElement>(`[data-geores="${itemId}-${target}"]`);
  if (!query) { setGeoStatus(itemId, target, "場所名を入力してください", "warn"); return; }
  setGeoStatus(itemId, target, "検索中…");
  if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  try {
    const results = await geocodeSearch(query);
    if (!results.length) { setGeoStatus(itemId, target, "見つかりませんでした。表記を変えて再検索を", "warn"); return; }
    if (results.length === 1) { applyGeo(itemId, target, results[0]); return; }
    if (resultsEl) {
      resultsEl.innerHTML = results
        .map((r, i) => `<button type="button" data-act="geo-pick" data-item="${itemId}" data-target="${target}" data-idx="${i}"><b>候補 ${i + 1}</b><small>${escapeHtml(r.label)}</small></button>`)
        .join("");
      resultsEl.hidden = false;
      geoCache.set(`${itemId}-${target}`, results);
      setGeoStatus(itemId, target, "候補から選んでください");
    }
  } catch (e) {
    setGeoStatus(itemId, target, e instanceof Error ? e.message : "検索に失敗しました", "warn");
  }
}

const geoCache = new Map<string, GeoResult[]>();

function applyGeo(itemId: number, target: GeoTarget, r: GeoResult): void {
  const found = findItem(itemId);
  if (!found) return;
  const [latKey, lngKey] = latLngKeys(target);
  found.item[latKey] = String(r.lat);
  found.item[lngKey] = String(r.lng);
  const resultsEl = daysEl.querySelector<HTMLElement>(`[data-geores="${itemId}-${target}"]`);
  if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  setGeoStatus(itemId, target, "地図に登録しました", "ok");
  markDirty();
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
  if (act === "city-del") {
    const id = Number(actEl.dataset.city || 0);
    model.cities = model.cities.filter((c) => c.id !== id);
    markDirty(); renderCities(); refreshMap(true);
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
    found.item.nights = Math.max(1, Number(target.value) || 1);
    markDirty();
    renderDays();
    refreshMap(false);
    return;
  }

  const field = fieldName as ItemStrKey;
  found.item[field] = target.value;

  // 場所系は内蔵テーブルで座標を補完
  if (field === "place" || field === "mapQuery") autoCoords(found.item, "place");
  if (field === "from") autoCoords(found.item, "from");
  if (field === "to") autoCoords(found.item, "to");

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

cityInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); void addCity(cityInput.value); cityInput.value = ""; }
});
qs<HTMLButtonElement>(root, "[data-city-add]").addEventListener("click", () => {
  void addCity(cityInput.value); cityInput.value = "";
});

function cityRangeLabel(city: City): string {
  const a = parseISO(city.fromDate);
  const b = parseISO(city.toDate);
  if (!a || !b) return "";
  const f = (d: Date): string => `${d.getMonth() + 1}/${d.getDate()}`;
  return city.fromDate === city.toDate ? f(a) : `${f(a)}〜${f(b)}`;
}

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

// ---- 保存・読み込み -----------------------------------------------------

function syncBasicInputs(): void {
  qs<HTMLInputElement>(root!, '[data-f="title"]').value = model.title || "";
  qs<HTMLInputElement>(root!, '[data-f="members"]').value = model.members || "";
  qs<HTMLInputElement>(root!, '[data-f="note"]').value = model.note || "";
  if (model.startDate && model.endDate) fp.setDate([model.startDate, model.endDate], false);
  titleEcho.textContent = model.title || "新しい計画";
}

function coordOut(s: string): number | "" {
  return s.trim() !== "" && !isNaN(num(s)) ? num(s) : "";
}

function buildData(): LocalPlanData {
  const itinerary: ItineraryItem[] = [];
  model.days.forEach((day, di) => {
    const dayLabel = `Day ${di + 1}`;
    const flush = (it: Item): void => {
      const base: ItineraryItem = {
        date: day.date, day: dayLabel, area: day.area || it.place || "",
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
    trip: { title: model.title || "無題の旅行", dates: datesString(), members: model.members || "", note: model.note || "" },
    itinerary,
    links: [],
    checklist: [],
  };
}

function loadExisting(): boolean {
  const meta = slug ? TripPlans.get(slug) : null;
  if (meta && meta.source && meta.source !== "local") {
    statusEl.textContent = "この計画は外部連携のため、ここでは編集できません";
    statusEl.className = "is-dirty";
    return false;
  }
  const data = slug ? TripPlans.getData(slug) : null;
  if (!data) return true;
  const trip = data.trip || { title: "", dates: "", members: "", note: "" };
  model.title = trip.title || "";
  model.members = trip.members || "";
  model.note = trip.note || "";
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
  model.cities = Array.from(cityNames).map((name) => {
    const hit = TripPlans.coordsFor(name);
    return { id: seq++, name, lat: hit ? String(hit.lat) : "", lng: hit ? String(hit.lng) : "", fromDate: "", toDate: "" };
  });
  return true;
}

function normalizeKind(type: string | undefined): ItemKind {
  const t = String(type || "");
  return (["sight", "food", "move", "stay", "todo", "form"] as ItemKind[]).includes(t as ItemKind) ? (t as ItemKind) : "sight";
}

function save(): void {
  if (!model.title.trim()) {
    statusEl.textContent = "旅行名を入れてください";
    statusEl.className = "is-dirty";
    qs<HTMLInputElement>(root!, '[data-f="title"]').focus();
    return;
  }
  if (!slug) { slug = TripPlans.uniqueSlug(model.title || "trip"); model.slug = slug; }
  TripPlans.saveLocalPlan(slug, buildData());
  TripPlans.setActiveSlug(slug);
  dirty = false;
  statusEl.textContent = "保存しました";
  statusEl.className = "is-ok";
  openLink.href = "index.html?plan=" + encodeURIComponent(slug);
  openLink.hidden = false;
  savebarNoteEl.textContent = "保存しました。右上の「表示」でダッシュボードを確認できます。";
  try { history.replaceState(null, "", "plan-editor.html?plan=" + encodeURIComponent(slug)); } catch { /* ignore */ }
}

// ---- ヘッダーアイコン・初期化 -------------------------------------------

qs<HTMLAnchorElement>(root, "[data-back]").innerHTML = icon("arrowLeft") + "<span>一覧</span>";
openLink.innerHTML = icon("arrowTopRightOnSquare") + "<span>表示</span>";
const saveBtn = qs<HTMLButtonElement>(root, "[data-save]");
saveBtn.innerHTML = icon("bookmark") + "<span>今すぐ保存</span>";
saveBtn.addEventListener("click", save);
qs<HTMLButtonElement>(root, "[data-city-add]").innerHTML = icon("plus") + "<span>追加</span>";
qs<HTMLElement>(root, "[data-local-note]").insertAdjacentHTML("afterbegin", icon("informationCircle") + " ");

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
mapShow.innerHTML = icon("map") + "<span>地図を表示</span>";
function setMapCollapsed(collapsed: boolean): void {
  root!.classList.toggle("map-collapsed", collapsed);
  mapShow.hidden = !collapsed;
  mapToggle.textContent = collapsed ? "地図を表示" : "地図を隠す";
  try { localStorage.setItem("pe-map-collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  if (!collapsed) window.setTimeout(() => { if (map) { map.invalidateSize(); refreshMap(true); } }, 60);
}
mapToggle.addEventListener("click", () => setMapCollapsed(!root!.classList.contains("map-collapsed")));
mapShow.addEventListener("click", () => setMapCollapsed(false));

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
  if (dirty && model.title.trim()) persist();
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});

const editable = loadExisting();
if (slug) { openLink.href = "index.html?plan=" + encodeURIComponent(slug); openLink.hidden = false; }
syncBasicInputs();
rebuildDays();
renderCities();
renderDays();
initMap();
refreshMap(true);
// 地図の初期表示：保存設定があれば従う。無指定かつ小さい画面では既定で畳む（リスト優先）
const savedMapPref = localStorage.getItem("pe-map-collapsed");
if (savedMapPref === "1" || (savedMapPref == null && window.matchMedia("(max-width: 760px)").matches)) {
  setMapCollapsed(true);
}
statusEl.textContent = isNew ? "下書き（自動保存・未保存）" : editable ? "読み込み完了" : statusEl.textContent;

registerServiceWorker();
