import * as TripPlans from "../shared/plans-store";
import L from "leaflet";
import type { PlanMeta } from "../shared/plans-store";
import { escapeHtml } from "../shared/dom";
import { icon } from "../shared/icons";
import { addBaseLayer } from "../shared/map-tiles";
import {
  destinationsEl,
  locationExplorerEl,
  locationSideEl,
  locationHeadEl,
  locationPlansEl,
  locationScheduleEl,
  mapBoardEl,
  destinationCountEl,
  mapCountEl,
} from "./dom";
import { state } from "./state";
import { destinationRows, plansForLocation } from "./plan-locations";
import { emptyList } from "./plan-card";
import { renderRankings } from "./rankings";
import { renderSchedule } from "./schedule";

type LocationTransition = "forward" | "back" | "swap";

let pendingLocationTransition: LocationTransition | "" = "";
let locationTransitionTimer = 0;
const locationMapState: { map: L.Map | null; layer: L.LayerGroup | null } = { map: null, layer: null };

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

export function queueLocationTransition(direction: LocationTransition): void {
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

export function renderDiscover(publicPlans: PlanMeta[]): void {
  renderRankings(publicPlans);
  renderLocationExplorer(publicPlans);
}
