// Leaflet を初期バンドルから切り離すための軽量ファサード。
// 地図を開くまで ./map（Leafletを含む）は import しない。

import type { GeoResult } from "../shared/geocoding";
import type { GeoTarget } from "./editor-state";
import { root, mapHeaderBtn, mapToggle } from "./editor-dom";
import type { MapHandlers } from "./map";

type MapModule = typeof import("./map");
let loaded: MapModule | null = null;
let loading: Promise<MapModule> | null = null;
let handlers: MapHandlers | null = null;

function loadMap(): Promise<MapModule> {
  if (loaded) return Promise.resolve(loaded);
  loading ||= import("./map").then((module) => {
    loaded = module;
    if (handlers) module.setMapHandlers(handlers);
    return module;
  });
  return loading;
}

function applyCollapsedUi(collapsed: boolean): void {
  root.classList.toggle("map-collapsed", collapsed);
  mapHeaderBtn.classList.toggle("is-on", !collapsed);
  mapHeaderBtn.setAttribute("aria-label", collapsed ? "地図を表示" : "地図を隠す");
  mapHeaderBtn.setAttribute("title", collapsed ? "地図を表示" : "地図を隠す");
  mapToggle.textContent = collapsed ? "地図を表示" : "地図を隠す";
  try { localStorage.setItem("pe-map-collapsed", collapsed ? "1" : "0"); } catch { /* ignore */ }
}

export function setMapHandlers(next: MapHandlers): void {
  handlers = next;
  loaded?.setMapHandlers(next);
}

export function ensureMap(): void {
  void loadMap().then((module) => module.ensureMap());
}

export function setMapCollapsed(collapsed: boolean): void {
  applyCollapsedUi(collapsed);
  if (collapsed) {
    loaded?.setMapCollapsed(true);
    return;
  }
  void loadMap().then((module) => module.setMapCollapsed(false));
}

export function refreshMap(fit: boolean): void {
  loaded?.refreshMap(fit);
}

let refreshTimer = 0;
export function scheduleMapRefresh(): void {
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => loaded?.refreshMap(false), 500);
}

export function showCandidates(itemId: number, target: GeoTarget, results: GeoResult[]): void {
  void loadMap().then((module) => module.showCandidates(itemId, target, results));
}

export function clearCandidates(): void {
  loaded?.clearCandidates();
}

// スマホの地図ボトムシートはDOMだけでリサイズし、既に開かれた地図だけ再描画する。
export function bindMapResizeGrip(): void {
  const mapGrip = root.querySelector<HTMLElement>("[data-map-grip]");
  const mapWrapEl = root.querySelector<HTMLElement>(".pe-mapwrap");
  if (!mapGrip || !mapWrapEl) return;
  const MIN_MAP_H = 180;
  const maxMapH = (): number => Math.round(window.innerHeight * 0.92);
  let resizeRaf = 0;
  let dragging = false;
  const invalidate = (): void => loaded?.invalidateMap();
  const applyMapHeight = (height: number, persist = true): void => {
    const h = Math.max(MIN_MAP_H, Math.min(maxMapH(), Math.round(height)));
    root.style.setProperty("--pe-map-h", `${h}px`);
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(invalidate);
    if (persist) { try { localStorage.setItem("pe-map-h", String(h)); } catch { /* ignore */ } }
  };
  mapGrip.addEventListener("pointerdown", (event) => {
    dragging = true;
    root.classList.add("is-map-resizing");
    try { mapGrip.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    event.preventDefault();
  });
  mapGrip.addEventListener("pointermove", (event) => {
    if (dragging) applyMapHeight(window.innerHeight - event.clientY);
  });
  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("is-map-resizing");
    try { mapGrip.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    invalidate();
  };
  mapGrip.addEventListener("pointerup", endDrag);
  mapGrip.addEventListener("pointercancel", endDrag);
  mapGrip.addEventListener("keydown", (event) => {
    const current = mapWrapEl.getBoundingClientRect().height;
    if (event.key === "ArrowUp") { applyMapHeight(current + 24); event.preventDefault(); }
    else if (event.key === "ArrowDown") { applyMapHeight(current - 24); event.preventDefault(); }
  });
  try {
    const saved = Number(localStorage.getItem("pe-map-h"));
    if (saved >= MIN_MAP_H) applyMapHeight(saved, false);
  } catch { /* ignore */ }
}
