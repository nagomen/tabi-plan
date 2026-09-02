// 地図の下地（背景の地図そのもの）の指定を1か所にまとめる。
//
// もともとは OpenStreetMap の標準タイルを4画面それぞれで直に書いていた。
// 標準タイルは彩度が高く、道路の階層や地名の優先度が分かりにくい。
//
// 旅行中のモバイル回線と省電力端末を優先し、軽量なCARTO Voyagerを使う。
// MapLibreの約1MBの実行コードとWebGL初期化を不要にする。

import type * as LType from "leaflet";

const RASTER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

const RASTER_OPTIONS = {
  subdomains: "abcd",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
    ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
};

/**
 * 地図に軽量な下地を敷く。
 */
export function addBaseLayer(L: typeof LType, map: LType.Map): void {
  L.tileLayer(RASTER_URL, RASTER_OPTIONS).addTo(map);
}
