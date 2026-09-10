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

export function renderMap(pins: HistoryPin[]): void {
  allPins = pins;
  const mapEl = $("[data-map]");
  if (!mapEl) return;

  const filterEl = $<HTMLSelectElement>("[data-map-filter]");
  if (filterEl) {
    filterEl.hidden = !allPins.length;
    if (filterEl.dataset.bound !== "true") {
      filterEl.dataset.bound = "true";
      filterEl.addEventListener("change", () => {
        filterMonths = Number(filterEl.value) || 0;
        updateMapMarkers();
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

  if (!personMap) {
    mapEl.innerHTML = "";
    personMap = L.map(mapEl, { scrollWheelZoom: false, attributionControl: true });
    addBaseLayer(L, personMap);
    markersLayer = L.layerGroup().addTo(personMap);
  }
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
