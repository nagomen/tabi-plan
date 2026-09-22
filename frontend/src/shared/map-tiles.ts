// 地図の下地（背景の地図そのもの）の指定を1か所にまとめる。
//
// もとは CARTO Voyager を使っていたが、CARTO が鍵なしの配信に
// 「API KEY REQUIRED」の透かしを焼き込むようになり、全タイルが読めなくなった。
// 鍵なしで @2x（512px）を配信しているサービスは現状ほかに無いため、
// OpenStreetMap の標準タイルに戻し、高解像度は Leaflet 側で作る。
//
// MapLibre の約1MBの実行コードと WebGL 初期化は引き続き不要。

import type * as LType from "leaflet";

const RASTER_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** OpenStreetMap 標準タイルが配信している最大ズーム。 */
const MAX_ZOOM = 19;

const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

interface NetworkConnectionLike {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * 高解像度タイルを取りに行ってよいかを決める。
 *
 * detectRetina は 1枚のタイルの代わりに1段深いズームのタイルを4枚取る。
 * 高DPI端末では実質2倍の精細さになる代わりに通信量も増えるので、
 * ブラウザの通信量節約指定と低速回線では諦めて等倍のままにする。
 */
export function shouldUseRetinaTiles(connection?: NetworkConnectionLike): boolean {
  if (connection?.saveData) return false;
  if (connection?.effectiveType === "slow-2g" || connection?.effectiveType === "2g") return false;
  return true;
}

function currentConnection(): NetworkConnectionLike | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as Navigator & { connection?: NetworkConnectionLike }).connection;
}

/**
 * 地図に軽量な下地を敷く。
 */
export function addBaseLayer(L: typeof LType, map: LType.Map): void {
  L.tileLayer(RASTER_URL, {
    maxZoom: MAX_ZOOM,
    detectRetina: shouldUseRetinaTiles(currentConnection()),
    attribution: ATTRIBUTION,
  }).addTo(map);
}
