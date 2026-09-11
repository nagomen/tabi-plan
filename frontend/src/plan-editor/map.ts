import L from "leaflet";
import { escapeHtml } from "../shared/dom";
import { addBaseLayer } from "../shared/map-tiles";
import type { GeoResult } from "../shared/geocoding";
import { type GeoTarget, KINDS, KIND_COLOR, model, num, hasLatLng, stayCovering } from "./editor-state";
import { root, mapEl, mapHintEl, mapHeaderBtn, mapToggle } from "./editor-dom";

// ---- 地図（Leaflet ライブ） ---------------------------------------------

let map: L.Map | null = null;
let pinLayer: L.LayerGroup | null = null;
let routeLayer: L.LayerGroup | null = null;
let candidateLayer: L.LayerGroup | null = null;

interface MapHandlers {
  onMapClick: (latlng: L.LatLng) => void | Promise<void>;
  applyGeo: (itemId: number, target: GeoTarget, r: GeoResult) => void;
}

let handlers: MapHandlers = {
  onMapClick: () => undefined,
  applyGeo: () => undefined,
};

export function setMapHandlers(next: MapHandlers): void {
  handlers = next;
}

/**
 * 地図は開いたときに作る。
 *
 * これまでは起動時に必ず作っていたため、スマホで地図を畳んでいても
 * 地図エンジン（gzip 約 206KB）とベクタタイル（数百KB）を毎回読んでいた。
 * 見せないものを読まないようにする。
 */
export function ensureMap(): void {
  if (map) return;
  initMap();
  refreshMap(true);
}

function initMap(): void {
  map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([39.6, 140.6], 6);
  addBaseLayer(L, map);
  pinLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  candidateLayer = L.layerGroup().addTo(map);
  map.on("click", (e: L.LeafletMouseEvent) => handlers.onMapClick(e.latlng));
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
export function showCandidates(itemId: number, target: GeoTarget, results: GeoResult[]): void {
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
    marker.on("click", () => handlers.applyGeo(itemId, target, r));
    marker.addTo(candidateLayer!);
  });
  if (pts.length && map) map.fitBounds(L.latLngBounds(pts).pad(0.35), { maxZoom: 14 });
  mapHintEl.textContent = "地図の候補ピンをクリックして選択";
}

export function clearCandidates(): void {
  if (candidateLayer) candidateLayer.clearLayers();
}

export function refreshMap(fit: boolean): void {
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

let mapTimer = 0;
export function scheduleMapRefresh(): void {
  window.clearTimeout(mapTimer);
  mapTimer = window.setTimeout(() => refreshMap(false), 500);
}

// 地図の表示/非表示

export function setMapCollapsed(collapsed: boolean): void {
  if (!collapsed) ensureMap();
  root.classList.toggle("map-collapsed", collapsed);
  mapHeaderBtn.classList.toggle("is-on", !collapsed);
  mapHeaderBtn.setAttribute("aria-label", collapsed ? "地図を表示" : "地図を隠す");
  mapHeaderBtn.setAttribute("title", collapsed ? "地図を表示" : "地図を隠す");
  mapToggle.textContent = collapsed ? "地図を表示" : "地図を隠す";
  try { localStorage.setItem("pe-map-collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
  if (!collapsed) window.setTimeout(() => { if (map) { map.invalidateSize(); refreshMap(true); } }, 60);
}

// スマホ: 地図ボトムシートの境界をドラッグして高さを変更
export function bindMapResizeGrip(): void {
  const mapGrip = root.querySelector<HTMLElement>("[data-map-grip]");
  const mapWrapEl = root.querySelector<HTMLElement>(".pe-mapwrap");
  if (mapGrip && mapWrapEl) {
    const MIN_MAP_H = 180;
    const maxMapH = (): number => Math.round(window.innerHeight * 0.92);
    let resizeRaf = 0;
    let dragging = false;
    const applyMapHeight = (height: number, persist = true): void => {
      const h = Math.max(MIN_MAP_H, Math.min(maxMapH(), Math.round(height)));
      root.style.setProperty("--pe-map-h", `${h}px`);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => { if (map) map.invalidateSize({ animate: false }); });
      if (persist) { try { localStorage.setItem("pe-map-h", String(h)); } catch { /* ignore */ } }
    };
    mapGrip.addEventListener("pointerdown", (e) => {
      dragging = true;
      root.classList.add("is-map-resizing");
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
      root.classList.remove("is-map-resizing");
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
}
