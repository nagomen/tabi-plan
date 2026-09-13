import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { escapeHtml } from "../shared/dom";
import type { HistoryPin } from "../shared/travel-history";
import { countryOf } from "../shared/country";
import { addBaseLayer } from "../shared/map-tiles";
import { $, today } from "./context";
import { fmtShort, fmtFull } from "./date-format";

let personMap: L.Map | null = null;
let markersLayer: L.LayerGroup | null = null;
let allPins: HistoryPin[] = [];
let filterMonths = 0; // 0 = 全期間
let focusTripSlug = ""; // 初期表示で寄せる旅行

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

/**
 * @param focusSlug 初期表示で寄せる旅行（直近の旅行）の slug。
 *   ピンは全期間ぶん描いたうえで、最初の表示範囲だけこの旅行に合わせる。
 *   縮小すれば他の旅行のピンもそのまま見える。
 */
export function renderMap(pins: HistoryPin[], focusSlug = ""): void {
  allPins = pins;
  focusTripSlug = focusSlug;
  const mapEl = $("[data-map]");
  if (!mapEl) return;

  const filterEl = $<HTMLSelectElement>("[data-map-filter]");
  if (filterEl) {
    filterEl.hidden = !allPins.length;
    if (filterEl.dataset.bound !== "true") {
      filterEl.dataset.bound = "true";
      filterEl.addEventListener("change", () => {
        filterMonths = Number(filterEl.value) || 0;
        // 期間を変えたときは、その期間の全ピンが入るように引き直す。
        updateMapMarkers("all");
      });
    }
  }

  if (!allPins.length) {
    if (personMap) personMap.remove();
    personMap = null;
    markersLayer = null;
    mapEl.innerHTML = `<div class="pv-empty"><b>地図データがありません</b><span>行程に場所が登録されると地図に表示されます</span></div>`;
    return;
  }

  // 地図を作ったときだけ直近の旅行へ寄せる。以降の描き直し（裏の再取得）では
  // 表示範囲を触らない＝利用者が動かした位置を勝手に戻さない。
  const isFirstDraw = !personMap;
  if (!personMap) {
    mapEl.innerHTML = "";
    personMap = L.map(mapEl, { scrollWheelZoom: false, attributionControl: true });
    addBaseLayer(L, personMap);
    markersLayer = L.layerGroup().addTo(personMap);
  }
  updateMapMarkers(isFirstDraw ? "focus" : "keep");
}

/** 直近の旅行で訪れたピン（表示中の期間に限る）。 */
function focusPins(): HistoryPin[] {
  if (!focusTripSlug) return [];
  return filteredPins().filter((pin) => pin.visits.some((visit) => visit.tripSlug === focusTripSlug));
}

function fitTo(pins: HistoryPin[], maxZoom?: number): void {
  if (!personMap || !pins.length) return;
  const latlngs: L.LatLngExpression[] = pins.map((pin) => [pin.lat, pin.lng]);
  if (latlngs.length === 1) personMap.setView(latlngs[0], 9);
  else personMap.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom });
}

function updateMapMarkers(fit: "focus" | "all" | "keep" = "all"): void {
  const countEl = $("[data-map-count]");
  if (!personMap || !markersLayer) return;
  const pins = filteredPins();
  if (countEl) {
    countEl.textContent = pins.length ? `${pins.length}地点` : filterMonths > 0 ? "該当なし" : "";
  }

  markersLayer.clearLayers();
  pins.forEach((pin) => {
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

  if (fit === "keep") return;
  // 初期表示は直近の旅行だけに寄せる（寄せすぎないよう最大ズームを抑える）。
  // その旅行のピンが無いときは全ピンに合わせる。
  const focused = fit === "focus" ? focusPins() : [];
  if (focused.length) fitTo(focused, 11);
  else fitTo(pins);
}
