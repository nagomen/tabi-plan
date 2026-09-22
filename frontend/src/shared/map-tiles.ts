// 地図の下地（背景の地図そのもの）の指定を1か所にまとめる。
//
// 鮮明さを優先し、OpenFreeMap Liberty のベクタータイルを MapLibre GL で描画する。
// 画像タイルを拡大しないため、ズームしてもモザイク状にならない。
// WebGL が使えない端末や読み込み失敗時だけ CARTO Voyager へフォールバックする。

import type * as LType from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";

const VECTOR_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const VECTOR_ATTRIBUTION =
  '<a href="https://openfreemap.org/">OpenFreeMap</a>' +
  ' &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a>' +
  ' Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const FALLBACK_RASTER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

const FALLBACK_RASTER_OPTIONS = {
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

/** 地図に鮮明なベクター下地を敷く。 */
export function addBaseLayer(L: typeof LType, map: LType.Map): void {
  if (!supportsWebGL()) {
    addFallbackRasterLayer(L, map);
    return;
  }

  void (async () => {
    try {
      // 連携プラグインが MapLibre 本体も読み込む。地図の初期化時に確実に完了させ、
      // 失敗した場合だけ通常画像タイルへ切り替える。
      const { maplibreGL } = await import("@maplibre/maplibre-gl-leaflet");
      const layer = maplibreGL({ style: VECTOR_STYLE });
      layer.addTo(map);
      map.attributionControl?.addAttribution(VECTOR_ATTRIBUTION);
      useJapaneseLabels(layer);
    } catch (error) {
      console.warn("[map] ベクター地図を読み込めないため通常地図へ切り替えます", error);
      addFallbackRasterLayer(L, map);
    }
  })();
}

function addFallbackRasterLayer(L: typeof LType, map: LType.Map): void {
  L.tileLayer(FALLBACK_RASTER_URL, FALLBACK_RASTER_OPTIONS).addTo(map);
}

/** ベクタースタイル内の地名を、日本語・現地名・ローマ字の順で表示する。 */
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
        // 一部の記号レイヤーで弾かれても、ほかの地名は日本語化する。
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
