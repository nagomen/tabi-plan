import * as TripPlans from "../shared/plans-store";
import { escapeHtml, errorMessage } from "../shared/dom";
import { geocodingAttribution, type GeoResult } from "../shared/geocoding";
import { type City, state, model, cityDateDefault } from "./editor-state";
import { citiesEl, cityInput, cityOptions, isComposingKey } from "./editor-dom";
import { countryFromText } from "./move-transport";
import { geocodeSearch } from "./geo-search";
import { markDirty } from "./persist";
import { refreshMap, scheduleMapRefresh } from "./map";
import { renderDays } from "./days-render";
import { renderCities } from "./cities-render";
import { armCity } from "./place-geocode";

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

export function onCityInputKeydown(e: KeyboardEvent): void {
  // 日本語入力の変換確定も Enter で来る。ここで追加してしまうと、
  // 追加のあとに確定した文字が入力欄へ書き戻されて残ってしまう。
  if (isComposingKey(e)) return;
  if (e.key === "Enter") { e.preventDefault(); void addCity(cityInput.value); }
}
export function onCityAddClick(): void {
  void addCity(cityInput.value);
}

// 都市の滞在期間（開始/終了日）の割り当て
export function onCitiesChange(event: Event): void {
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
}

// 都市の削除・地図検索
export function onCitiesClick(event: MouseEvent): void {
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
}

// 都市名の編集（フォーカス維持のため renderCities はしない）
export function onCitiesInput(event: Event): void {
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
}
