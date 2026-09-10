import { planCoverImageForLocation, type CoverPlace } from "../shared/cover";
import { normalizeDate } from "./api-data-source";
import type { DayGroup } from "./types";
import { setAppHeaderHero } from "../shared/app-header";
import type { TripData, RouteCity } from "../shared/types";
import { CONFIG, state } from "./state";
import { appHeaderEl, coverMeta } from "./dom";
import { dayCoord } from "./days";

interface HeaderCoverMeta {
  slug: string;
  route?: string;
  title: string;
  cover?: string;
}

function activeDayCoverMeta(): HeaderCoverMeta {
  const configuredCover = "cover" in coverMeta ? coverMeta.cover : "";
  return {
    ...coverMeta,
    cover: configuredCover || state.data.trip?.cover || "",
    route: coverMeta.route || "",
    title: state.data.trip?.title || coverMeta.title || CONFIG.tripTitle,
  };
}

/**
 * その日に「最初に」いる都市。都市メタデータ（cities の滞在期間）から、
 * 日付をカバーする都市のうち滞在開始が最も早いもの＝その日の朝いる都市を選ぶ。
 * 例: 台北 10/1〜10/3・東京 10/3〜10/5 なら、10/3 は台北（その後東京へ移動）。
 * ※ cityNameForDate は逆に「最後に到着した都市」を選ぶ（日ラベル用）。
 */
function firstCityOnDate(data: TripData, date: string): RouteCity | null {
  let best: RouteCity | null = null;
  let bestFrom = "";
  for (const city of data.cities || []) {
    const from = normalizeDate(city.fromDate);
    const to = normalizeDate(city.toDate);
    if (!city.name || !from || !to || date < from || to < date) continue;
    if (!best || from < bestFrom) {
      best = city;
      bestFrom = from;
    }
  }
  return best;
}

/**
 * ヘッダー画像の場所候補：その日に最初にいる都市（DBの都市メタデータ。座標付き）
 * → 日のエリア名 → その日の代表座標。すべて計画データ由来なので、
 * リモートで旅行内容を変えてもコードに触らず表示が追従する。
 */
function dayCoverPlaces(day: DayGroup): CoverPlace[] {
  const places: CoverPlace[] = [];
  const city = firstCityOnDate(state.data, day.date);
  if (city) places.push({ name: city.name.trim(), lat: city.lat, lng: city.lng });
  if (day.area) places.push({ name: day.area });
  const coord = dayCoord(day);
  if (coord) places.push(coord);
  return places;
}

export function updateHeaderHero(day: DayGroup): void {
  const meta = activeDayCoverMeta();
  setAppHeaderHero(appHeaderEl, planCoverImageForLocation(meta, dayCoverPlaces(day)));
}
