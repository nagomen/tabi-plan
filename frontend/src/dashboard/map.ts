import { renderLeafletMap } from "./leaflet-map";
import type { DayGroup } from "./types";
import { mapsSearchUrl } from "../shared/maps";
import type { ItineraryItem } from "../shared/types";
import { CONFIG, leafletState, linkByKey, state } from "./state";
import { qs, root } from "./dom";

/** 地図に投影したプレースポイント（x/y は SVG 用の割合座標） */
type ProjectedPlace = ItineraryItem & { x: number; y: number };

export function mapsDir(places: ItineraryItem[]): string {
  const clean = places.map((p) => p.mapQuery || p.place).filter(Boolean) as string[];
  if (clean.length < 2) return mapsSearchUrl(clean[0] || "");
  const origin = clean[0];
  const destination = clean[clean.length - 1];
  const waypoints = clean.slice(1, -1).join("|");
  return "https://www.google.com/maps/dir/?api=1&origin=" + encodeURIComponent(origin) +
    "&destination=" + encodeURIComponent(destination) +
    (waypoints ? "&waypoints=" + encodeURIComponent(waypoints) : "");
}

export function syncGoogleMapsLink(places: ItineraryItem[]): void {
  const link = qs<HTMLAnchorElement>("[data-my-maps]");
  const configured = linkByKey("maps").url || "";
  const fallbackPlaces = places.length ? places : projectPlaces(state.data.itinerary || []);
  const fallback = mapsDir(fallbackPlaces);
  link.href = configured || fallback;
  link.setAttribute("aria-disabled", link.href.endsWith("#") ? "true" : "false");
}

function mapsEmbedDirections(places: ItineraryItem[]): string {
  const clean = places.map((p) => p.mapQuery || p.place).filter(Boolean) as string[];
  if (!CONFIG.mapEmbed.mapsEmbedApiKey || clean.length < 2) return "";
  const origin = clean[0];
  const destination = clean[clean.length - 1];
  const waypoints = clean.slice(1, -1).join("|");
  return "https://www.google.com/maps/embed/v1/directions?key=" + encodeURIComponent(CONFIG.mapEmbed.mapsEmbedApiKey) +
    "&origin=" + encodeURIComponent(origin) +
    "&destination=" + encodeURIComponent(destination) +
    (waypoints ? "&waypoints=" + encodeURIComponent(waypoints) : "") +
    "&mode=transit";
}

function uniquePlaces(items: ItineraryItem[]): ItineraryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.mapQuery || item.place || item.title;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function projectPlaces(items: ItineraryItem[]): ProjectedPlace[] {
  const places = uniquePlaces(items);
  const withLatLng = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)) as (ItineraryItem & { lat: number; lng: number })[];
  if (withLatLng.length >= 2) {
    const lats = withLatLng.map((p) => p.lat);
    const lngs = withLatLng.map((p) => p.lng);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const latSpan = maxLat - minLat || 1;
    const lngSpan = maxLng - minLng || 1;
    return places.map((p, index) => ({
      ...p,
      x: Number.isFinite(p.lng) ? 10 + ((Number(p.lng) - minLng) / lngSpan) * 80 : 15 + index * 16,
      y: Number.isFinite(p.lat) ? 82 - ((Number(p.lat) - minLat) / latSpan) * 64 : 50,
    }));
  }
  return places.map((p, index) => ({ ...p, x: 12 + index * (76 / Math.max(1, places.length - 1)), y: index % 2 ? 42 : 58 }));
}

export function refreshMapLayout(): void {
  const map = leafletState.map;
  if (!map) return;
  map.invalidateSize();
  window.requestAnimationFrame(() => {
    leafletState.map?.invalidateSize();
    window.setTimeout(() => leafletState.map?.invalidateSize(), 120);
  });
}

// ---- 地図描画 -----------------------------------------------------------

export async function renderMapEmbed(activePlaces: ItineraryItem[], _day: DayGroup): Promise<void> {
  const map = qs<HTMLElement>("[data-map]");
  const existing = root.querySelector(".tl-map-iframe");
  if (existing) existing.remove();
  const existingLeaflet = root.querySelector(".tl-leaflet-map");
  map.classList.remove("has-leaflet");

  let src = "";
  if (CONFIG.mapEmbed.mode === "myMaps" && CONFIG.mapEmbed.myMapsEmbedUrl) {
    src = CONFIG.mapEmbed.myMapsEmbedUrl;
  } else if (CONFIG.mapEmbed.mode === "mapsEmbedApi") {
    src = mapsEmbedDirections(activePlaces);
  } else if (CONFIG.mapEmbed.mode === "leaflet") {
    try {
      await renderLeafletMap(map, leafletState, state.days, state.active, CONFIG.mapDefaults);
      refreshMapLayout();
    } catch (error) {
      console.warn(error);
    }
    return;
  }

  map.classList.toggle("has-embed", Boolean(src));
  if (existingLeaflet) existingLeaflet.remove();
  if (!src) return;

  const iframe = document.createElement("iframe");
  iframe.className = "tl-map-iframe";
  iframe.src = src;
  iframe.loading = "lazy";
  iframe.referrerPolicy = "no-referrer-when-downgrade";
  iframe.allowFullscreen = true;
  iframe.title = "Google Map";
  map.prepend(iframe);
}
