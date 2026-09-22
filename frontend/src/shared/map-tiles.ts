// 地図の下地（背景の地図そのもの）の指定を1か所にまとめる。
//
// もともとは OpenStreetMap の標準タイルを4画面それぞれで直に書いていた。
// 標準タイルは彩度が高く、道路の階層や地名の優先度が分かりにくい。
//
// 旅行中のモバイル回線と省電力端末を優先し、軽量なCARTO Voyagerを使う。
// 広域表示は256px、街区を見るズームでは512pxのタイルへ切り替え、
// MapLibre/WebGLの初期化コストなしで、通信量と鮮明さを両立する。

import type * as LType from "leaflet";

const STANDARD_RASTER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
const HIGH_RESOLUTION_RASTER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png";

/** 市街地レベルに入ったら高解像度タイルへ切り替える。 */
export const HIGH_RESOLUTION_TILE_MIN_ZOOM = 12;

interface NetworkConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

const RASTER_OPTIONS = {
  subdomains: "abcd",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
    ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
};

/**
 * 拡大時に高解像度タイルを使うかを決める。
 * ブラウザの通信量節約指定と2G回線は常に軽量版を優先する。
 */
export function tileDensityAtZoom(
  zoom: number,
  connection?: NetworkConnectionLike,
): "standard" | "high" {
  if (zoom < HIGH_RESOLUTION_TILE_MIN_ZOOM) return "standard";
  if (connection?.saveData) return "standard";
  if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return "standard";
  return "high";
}

function currentConnection(): NetworkConnectionLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkConnectionLike }).connection;
}

/**
 * 地図に、ズームと回線状況に合わせた下地を敷く。
 */
export function addBaseLayer(L: typeof LType, map: LType.Map): void {
  const connection = currentConnection();
  if (tileDensityAtZoom(HIGH_RESOLUTION_TILE_MIN_ZOOM, connection) === "standard") {
    L.tileLayer(STANDARD_RASTER_URL, RASTER_OPTIONS).addTo(map);
    return;
  }

  // minZoom/maxZoomでLeaflet自身に切り替えさせ、同一ズームで
  // 標準版と高解像度版を二重にダウンロードしない。
  L.tileLayer(STANDARD_RASTER_URL, {
    ...RASTER_OPTIONS,
    maxZoom: HIGH_RESOLUTION_TILE_MIN_ZOOM - 1,
  }).addTo(map);
  L.tileLayer(HIGH_RESOLUTION_RASTER_URL, {
    ...RASTER_OPTIONS,
    minZoom: HIGH_RESOLUTION_TILE_MIN_ZOOM,
  }).addTo(map);
}
