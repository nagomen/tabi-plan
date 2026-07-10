// dashboard/main.ts と dashboard/leaflet-map.ts が共有する型。
// 循環 import を避けるため、両方から参照される型だけをここに置く。

import type L from "leaflet";
import type { ItineraryItem } from "../shared/types";

/** 日別グループ（行程をその日の予定にまとめたもの） */
export interface DayGroup {
  date: string;
  day: string;
  area: string;
  weather: string;
  items: ItineraryItem[];
}

/** 描画用に座標を持った行程ポイント */
export interface RoutePoint extends ItineraryItem {
  role: string;
  dayIndex: number;
  dayLabel: string;
  lat: number;
  lng: number;
}

/** stopGroups の集約形 */
export interface StopGroup extends RoutePoint {
  dates: string[];
  dayIndexes: number[];
  places: Set<string>;
  titles: string[];
}

export interface LeafletState {
  map: L.Map | null;
  layer: L.LayerGroup | null;
  followActive: boolean;
}
