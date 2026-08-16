// 地図の下地（背景の地図そのもの）の指定を1か所にまとめる。
//
// もともとは OpenStreetMap の標準タイルを4画面それぞれで直に書いていた。
// 標準タイルは彩度が高く、道路の階層や地名の優先度が分かりにくい。
//
// いまは OpenFreeMap の Liberty を使う。ベクタータイルで、
// 「仙台市 / Sendai」のように現地語と英語が併記され、国道標識や緑地の
// 塗り分けも入る（Google マップに近い読みやすさ）。
// API キー不要・無料・利用量の制限なし。
//   https://openfreemap.org/
//
// ベクターの描画には MapLibre GL が要る。
// 全ページの初期読み込みに乗せたくないので、地図を実際に作るときだけ
// 動的 import で読む。WebGL が使えない端末や読み込みに失敗した場合は、
// ラスターの CARTO Voyager に落とす（キー不要・非商用は無料）。

import type * as LType from "leaflet";

const VECTOR_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const VECTOR_ATTRIBUTION =
  '<a href="https://openfreemap.org/">OpenFreeMap</a>' +
  ' &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a>' +
  ' Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const RASTER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

const RASTER_OPTIONS = {
  subdomains: "abcd",
  maxZoom: 20,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' +
    ' &copy; <a href="https://carto.com/attributions">CARTO</a>',
};

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * 地図に下地を敷く。呼び出し側は await しなくてよい
 * （ベクターの読み込みを待つ間もピンや線は普通に置ける）。
 */
export function addBaseLayer(L: typeof LType, map: LType.Map): void {
  if (!supportsWebGL()) {
    L.tileLayer(RASTER_URL, RASTER_OPTIONS).addTo(map);
    return;
  }
  void (async () => {
    try {
      // 連携プラグインが MapLibre を依存として読み込む。ここで別途 import すると
      // UMD 変換されたプラグイン内の分と二重にバンドルされる。
      await import("@maplibre/maplibre-gl-leaflet");
      const factory = (L as unknown as {
        maplibreGL?: (options: Record<string, unknown>) => LType.Layer;
      }).maplibreGL;
      if (!factory) throw new Error("maplibreGL レイヤーを作れませんでした");
      const layer = factory({ style: VECTOR_STYLE, attribution: VECTOR_ATTRIBUTION });
      layer.addTo(map);
      useJapaneseLabels(layer);
    } catch (error) {
      console.warn("[map] ベクタータイルを読めないのでラスターに落とします", error);
      L.tileLayer(RASTER_URL, RASTER_OPTIONS).addTo(map);
    }
  })();
}

/**
 * ラベルを日本語優先にする。
 *
 * 既定のスタイルは「臺北市 / Taipei」のように現地語と英語を並べる。
 * タイルには OSM の name:ja が入っているので（台北市・中壢区など）、
 * それを最優先にして、無ければ現地名 → ローマ字の順に落とす。
 *
 * 国道番号などの標識は text-field が ["get","ref"] で name を見ていないので、
 * name を含む指定の層だけ書き換える（書き換えると標識が消えてしまう）。
 */
function useJapaneseLabels(layer: LType.Layer): void {
  const gl = (layer as unknown as { getMaplibreMap?: () => MaplibreMap }).getMaplibreMap?.();
  if (!gl) return;
  const apply = (): void => {
    const layers = gl.getStyle()?.layers ?? [];
    for (const entry of layers) {
      if (entry.type !== "symbol") continue;
      const field = entry.layout?.["text-field"];
      if (!field || !JSON.stringify(field).includes("name")) continue;
      try {
        gl.setLayoutProperty(entry.id, "text-field", [
          "coalesce",
          ["get", "name:ja"],
          ["get", "name"],
          ["get", "name:latin"],
        ]);
      } catch {
        // 一部の層で弾かれても、他の層の書き換えは続ける
      }
    }
  };
  if (gl.isStyleLoaded()) apply();
  else gl.once("styledata", apply);
}

interface MaplibreMap {
  isStyleLoaded: () => boolean;
  once: (event: string, handler: () => void) => void;
  getStyle: () => { layers?: { id: string; type: string; layout?: Record<string, unknown> }[] } | undefined;
  setLayoutProperty: (layerId: string, name: string, value: unknown) => void;
}
