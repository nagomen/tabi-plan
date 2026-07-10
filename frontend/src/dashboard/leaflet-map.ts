// ダッシュボードの Leaflet 地図描画。
// 経路の地点集約・日付変更線をまたぐ座標のケア・視点フィットのみを担当し、
// state（選択中の日など）は main.ts から明示的な引数で受け取る（暗黙の module 変数に依存しない）。

import L from "leaflet";
import { escapeHtml } from "../shared/dom";
import type { MapDefaults } from "../shared/config";
import type { ItineraryItem } from "../shared/types";
import type { DayGroup, RoutePoint, StopGroup, LeafletState } from "./types";

function shortDate(date: string | undefined): string {
  return String(date || "").replace(/^\d{4}-0?/, "").replace("-", "/");
}

function compactDateRange(dates: string[]): string {
  const cleanDates = Array.from(new Set((dates || []).filter(Boolean))).sort();
  if (!cleanDates.length) return "";
  const first = shortDate(cleanDates[0]);
  const last = shortDate(cleanDates[cleanDates.length - 1]);
  return first === last ? first : `${first}-${last}`;
}

/** 行程を、地図に打つ座標つきの点列へ変換する（move は移動元/移動先の2点、それ以外は1点）。 */
function itineraryRoutePoints(days: DayGroup[]): RoutePoint[] {
  const points: RoutePoint[] = [];
  const pushPoint = (
    item: ItineraryItem,
    day: DayGroup,
    dayIndex: number,
    lat: unknown,
    lng: unknown,
    place: string | undefined,
    role: string,
  ): void => {
    const nextLat = Number(lat);
    const nextLng = Number(lng);
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) return;
    const previous = points[points.length - 1];
    const sameAsPrevious = previous && Math.abs(previous.lat - nextLat) < .0001 && Math.abs(previous.lng - nextLng) < .0001;
    if (sameAsPrevious && previous.dayIndex === dayIndex) return;
    points.push({
      ...item,
      role,
      dayIndex,
      dayLabel: item.day || day.day || `Day ${dayIndex + 1}`,
      date: item.date || day.date,
      area: item.area || day.area,
      place: place || item.place || item.area || item.title,
      lat: nextLat,
      lng: nextLng,
    });
  };

  days.forEach((day, dayIndex) => {
    day.items.forEach((item) => {
      if (Number.isFinite(item.originLat) && Number.isFinite(item.originLng) && Number.isFinite(item.destinationLat) && Number.isFinite(item.destinationLng)) {
        pushPoint(item, day, dayIndex, item.originLat, item.originLng, item.origin, "origin");
        pushPoint(item, day, dayIndex, item.destinationLat, item.destinationLng, item.destination || item.place, "destination");
        return;
      }
      pushPoint(item, day, dayIndex, item.lat, item.lng, item.place || item.area, "stay");
    });
  });
  return points;
}

type Segment = [[number, number], [number, number]];

/** 2点間が日付変更線をまたぐ場合、またぐ位置で2本のセグメントに割る。 */
function splitAntimeridianSegment(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Segment[] {
  const start = { lat: Number(from.lat), lng: Number(from.lng) };
  const end = { lat: Number(to.lat), lng: Number(to.lng) };
  if (![start.lat, start.lng, end.lat, end.lng].every(Number.isFinite)) return [];
  const delta = end.lng - start.lng;
  if (Math.abs(delta) <= 180) return [[[start.lat, start.lng], [end.lat, end.lng]]];

  const adjustedEndLng = delta > 180 ? end.lng - 360 : end.lng + 360;
  const edgeLng = delta > 180 ? -180 : 180;
  const wrappedEdgeLng = delta > 180 ? 180 : -180;
  const ratio = (edgeLng - start.lng) / (adjustedEndLng - start.lng);
  const edgeLat = start.lat + (end.lat - start.lat) * ratio;
  return [
    [[start.lat, start.lng], [edgeLat, edgeLng]],
    [[edgeLat, wrappedEdgeLng], [end.lat, end.lng]],
  ];
}

function addRoutePolylines(layer: L.LayerGroup, points: { lat: number; lng: number }[], options: L.PolylineOptions): void {
  for (let index = 0; index < points.length - 1; index++) {
    splitAntimeridianSegment(points[index], points[index + 1]).forEach((segment) => {
      L.polyline(segment, options).addTo(layer);
    });
  }
}

function crossesAntimeridian(points: { lng: number | string }[]): boolean {
  return (points || []).some((point, index) => {
    const next = points[index + 1];
    return next ? Math.abs(Number(next.lng) - Number(point.lng)) > 180 : false;
  });
}

function pacificMapPoint<T extends { lng: number }>(point: T, enabled: boolean): T {
  if (!enabled || Number(point.lng) >= 0) return point;
  return { ...point, lng: Number(point.lng) + 360 };
}

function boundsAroundPoint(point: { lat: number; lng: number } | undefined, radiusKm: number): L.LatLngBounds | null {
  const lat = Number(point && point.lat);
  const lng = Number(point && point.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const latDelta = radiusKm / 111.32;
  const cosLat = Math.max(.18, Math.abs(Math.cos(lat * Math.PI / 180)));
  const lngDelta = radiusKm / (111.32 * cosLat);
  return L.latLngBounds([[lat - latDelta, lng - lngDelta], [lat + latDelta, lng + lngDelta]]);
}

function uniqueMapPoints<T extends { lat: number; lng: number }>(points: T[]): T[] {
  const seen = new Set<string>();
  return (points || []).filter((point) => {
    const lat = Number(point && point.lat);
    const lng = Number(point && point.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundsAroundPoints(points: { lat: number; lng: number }[], radiusKm: number): L.LatLngBounds | null {
  const validPoints = uniqueMapPoints(points);
  if (!validPoints.length) return null;
  if (validPoints.length === 1) return boundsAroundPoint(validPoints[0], radiusKm);
  const pointBounds = L.latLngBounds(validPoints.map((point) => [point.lat, point.lng] as [number, number]));
  const centerBounds = boundsAroundPoint(pointBounds.getCenter(), radiusKm);
  if (centerBounds && centerBounds.contains(pointBounds.getSouthWest()) && centerBounds.contains(pointBounds.getNorthEast())) {
    return centerBounds;
  }
  return pointBounds;
}

/**
 * Leaflet 地図を（無ければ生成して）mapEl 内に描画する。
 * leafletState は main.ts 側の状態オブジェクトをそのまま渡してもらい、
 * map/layer の生成結果をその場で書き戻す（呼び出し側は同じ参照を見続けられる）。
 */
export async function renderLeafletMap(
  mapEl: HTMLElement,
  leafletState: LeafletState,
  days: DayGroup[],
  activeIndex: number,
  mapDefaults: MapDefaults,
): Promise<void> {
  mapEl.classList.remove("has-embed");
  mapEl.classList.add("has-leaflet");
  mapEl.querySelectorAll(".tl-map-iframe").forEach((node) => node.remove());

  let container = mapEl.querySelector<HTMLElement>(".tl-leaflet-map");
  if (!container) {
    container = document.createElement("div");
    container.className = "tl-leaflet-map";
    mapEl.prepend(container);
  }

  if (!leafletState.map) {
    leafletState.map = L.map(container, {
      zoomControl: true,
      scrollWheelZoom: true,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(leafletState.map);
  }
  const lmap = leafletState.map;

  if (leafletState.layer) {
    leafletState.layer.remove();
  }
  leafletState.layer = L.layerGroup().addTo(lmap);
  const layer = leafletState.layer;

  const allPoints = itineraryRoutePoints(days);
  const activePoints = allPoints.filter((point) => point.dayIndex === activeIndex);
  const usePacificWorld = crossesAntimeridian(activePoints);
  const displayAllPoints = allPoints.map((point) => pacificMapPoint(point, usePacificWorld));
  const displayActivePoints = activePoints.map((point) => pacificMapPoint(point, usePacificWorld));
  const activeLatLngs = displayActivePoints.map((point) => [point.lat, point.lng]);
  const showActiveDetail = leafletState.followActive && activeLatLngs.length;

  for (let index = 0; index < displayAllPoints.length - 1; index++) {
    const point = displayAllPoints[index];
    const next = displayAllPoints[index + 1];
    addRoutePolylines(layer, [point, next], {
      color: "#7b8f86",
      weight: 2,
      opacity: .55,
      dashArray: "6 8",
    });
  }

  if (showActiveDetail && activeLatLngs.length >= 2) {
    addRoutePolylines(layer, displayActivePoints, {
      color: "#0b5a42",
      weight: 4,
      opacity: .95,
    });
  }

  const stopGroups: StopGroup[] = [];
  const stopByCoord = new Map<string, StopGroup>();
  displayAllPoints.forEach((point) => {
    const key = `${point.lat.toFixed(3)},${point.lng.toFixed(3)}`;
    if (!stopByCoord.has(key)) {
      const group: StopGroup = { ...point, dates: [], dayIndexes: [], places: new Set<string>(), titles: [] };
      stopByCoord.set(key, group);
      stopGroups.push(group);
    }
    const group = stopByCoord.get(key)!;
    group.dates.push(point.date);
    group.dayIndexes.push(point.dayIndex + 1);
    if (point.place || point.area) group.places.add(point.place || point.area || "");
    if (point.title) group.titles.push(point.title);
  });

  stopGroups.forEach((point) => {
    const stopDays = Array.from(new Set(point.dayIndexes)).sort((a, b) => a - b);
    const dateLabel = compactDateRange(point.dates);
    const placeLabel = Array.from(point.places)[0] || point.place || point.area || point.title || "";
    const icon = L.divIcon({
      className: "",
      html: `<div class="tl-map-marker is-route-stop" tabindex="0" aria-label="${escapeHtml(dateLabel)} ${escapeHtml(placeLabel)}">
        <span class="tl-map-marker-num">${escapeHtml(shortDate(point.date) || String(stopDays[0]))}</span>
      </div>`,
      iconSize: [42, 26],
      iconAnchor: [19, 15],
    });
    L.marker([point.lat, point.lng], { icon })
      .bindPopup(`<b>${escapeHtml(dateLabel)} / ${escapeHtml(placeLabel)}</b><br>${point.titles.slice(0, 4).map((title) => escapeHtml(title)).join("<br>")}`)
      .addTo(layer);
  });

  if (showActiveDetail) {
    displayActivePoints.forEach((point) => {
      const icon = L.divIcon({
        className: "",
        html: `<div class="tl-map-marker is-active" tabindex="0" aria-label="${escapeHtml(shortDate(point.date))} ${escapeHtml(point.place || point.area || point.title || "")}">
          <span class="tl-map-marker-num">${escapeHtml(shortDate(point.date) || String(point.dayIndex + 1))}</span>
        </div>`,
        iconSize: [46, 28],
        iconAnchor: [21, 16],
      });
      L.marker([point.lat, point.lng], { icon })
        .bindPopup(`<b>${escapeHtml(shortDate(point.date))} / ${escapeHtml(point.place || point.area || "")}</b><br>${escapeHtml(point.title || "")}<br>${escapeHtml(point.note || "")}`)
        .addTo(layer);
    });
  }

  const defaultCenter: [number, number] = Array.isArray(mapDefaults.center) && mapDefaults.center.length === 2
    ? mapDefaults.center
    : [20, 0];
  const defaultZoom = Number(mapDefaults.zoom) || 2;
  const overviewRadiusKm = Number(mapDefaults.overviewRadiusKm) || 800;
  // 日詳細のダッシュボードなので、まず選択中の日の地点の実範囲にフィットする
  // （広い半径パディングは使わず、maxZoom で都市レベルに収める）。
  // 当日の地点が無いときだけ全行程の概観にフォールバック。
  let bounds: L.LatLngBounds | null = null;
  let fitMaxZoom = 13;
  if (activeLatLngs.length) {
    bounds = L.latLngBounds(activeLatLngs as L.LatLngExpression[]);
    fitMaxZoom = 13;
  } else if (displayAllPoints.length) {
    bounds = boundsAroundPoints(displayAllPoints, overviewRadiusKm);
    fitMaxZoom = 16;
  }
  if (bounds && bounds.isValid()) {
    lmap.fitBounds(bounds.pad(.35), {
      animate: false,
      maxZoom: fitMaxZoom,
    });
  } else {
    lmap.setView(defaultCenter, defaultZoom, { animate: false });
  }

  setTimeout(() => lmap.invalidateSize(), 0);
}
