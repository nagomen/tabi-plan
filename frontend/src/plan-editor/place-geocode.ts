import type L from "leaflet";
import { escapeHtml } from "../shared/dom";
import { icon } from "../shared/icons";
import {
  automaticGeocodingAvailable,
  geocodingAttribution,
  reverseCityName,
  reverseLocation,
  type GeoResult,
} from "../shared/geocoding";
import { type Item, type GeoTarget, state, model, findItem, latLngKeys } from "./editor-state";
import { root, daysEl, citiesEl, mapEl, mapHintEl, toast } from "./editor-dom";
import { maybeDefaultMoveTransport, syncTransportSelect } from "./move-transport";
import {
  MAPBOX_TOKEN, geocodeSearch, geocodeContextForDay, geoQueryForItem, conciseGeoLabel, geoAppliedMessage, formatLatLng,
} from "./geo-search";
import { markDirty } from "./persist";
import { refreshMap, clearCandidates, showCandidates, setMapCollapsed } from "./map";
import { refreshNode, refreshDayHeader } from "./days-render";
import { renderCities } from "./cities-render";

export async function onMapClick(latlng: L.LatLng): Promise<void> {
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

export function disarm(): void {
  state.armed = null;
  state.armedCity = null;
  mapHintEl.textContent = "";
  mapEl.style.cursor = "";
  daysEl.querySelectorAll(".pe-mini.is-armed").forEach((b) => b.classList.remove("is-armed"));
  clearCandidates();
}

export function arm(itemId: number, target: GeoTarget, button: HTMLElement): void {
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
export function armCity(cityId: number, button: HTMLElement): void {
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

export async function runGeocode(
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

export const geoCache = new Map<string, GeoResult[]>();
export const geoSuggestTimers = new Map<number, number>();
const geoRequestSeq = new Map<string, number>();

function invalidateGeoRequest(itemId: number, target: GeoTarget): void {
  const key = `${itemId}-${target}`;
  geoRequestSeq.set(key, (geoRequestSeq.get(key) || 0) + 1);
  setPlaceLoading(itemId, target, false);
}

export function clearGeoResults(itemId: number, target: GeoTarget): void {
  invalidateGeoRequest(itemId, target);
  const resultsEl = daysEl.querySelector<HTMLElement>(`[data-geores="${itemId}-${target}"]`);
  if (resultsEl) { resultsEl.hidden = true; resultsEl.innerHTML = ""; }
  geoCache.delete(`${itemId}-${target}`);
}

export function scheduleNamePlaceSuggest(item: Item): void {
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

export function applyGeo(itemId: number, target: GeoTarget, r: GeoResult): void {
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
