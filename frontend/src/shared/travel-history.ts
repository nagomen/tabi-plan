// ある人（名前）の「旅行履歴」を、参加している計画から集計する。
// person ページ（地図＋カレンダー＋旅行リスト）が使う。
//
// 履歴の実体は「その名前がメンバーに含まれる計画」の集合。各計画から
//  - 期間（行程の日付の最小〜最大、無ければ meta.dates、無ければ都市の日付）
//  - 訪問地（都市 cities、無ければ行程の area/place を重複なく）
//  - 地図ピン（都市/行程の緯度経度、無ければ地名→座標テーブル coordsFor）
// を取り出す。将来アカウント連携が入っても personTrips のシグネチャは維持する。

import * as TripPlans from "./plans-store";
import type { PlanMeta } from "./plans-store";
import type { ItineraryItem, RouteCity, LatLng } from "./types";
import { splitNames } from "./friend-store";
import { countryOf } from "./country";
import { parseFlexibleDate } from "./date";

export interface TripPoint extends LatLng {
  label: string;
  /** 訪問日（その場所の行程日。無ければ旅行の開始日で補完）。期間フィルターに使う。 */
  date?: Date;
}

export interface PersonTrip {
  plan: PlanMeta;
  /** 期間（不明なら null）。start<=end。 */
  start: Date | null;
  end: Date | null;
  /** 訪問地名（重複なし・訪問順）。 */
  places: string[];
  /** 地図ピン（重複なし）。座標が引けた地点のみ。 */
  points: TripPoint[];
}

// ---- 小さなユーティリティ ----------------------------------------------

function num(value: number | string | undefined): number {
  const n = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(n) ? n : NaN;
}

/** 計画の期間を返す。行程の日付があれば最小〜最大、無ければ meta.dates、無ければ都市の日付。 */
function rangeOf(meta: PlanMeta, itinerary: ItineraryItem[], cities: RouteCity[]): { start: Date | null; end: Date | null } {
  const dates = itinerary
    .map((it) => parseFlexibleDate(it.date))
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };

  const parts = String(meta.dates || "")
    .split(/[-–—〜~]/)
    .map((s) => parseFlexibleDate(s.trim()))
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  if (parts.length) return { start: parts[0], end: parts[parts.length - 1] };

  const cityDates = cities
    .flatMap((c) => [parseFlexibleDate(c.fromDate), parseFlexibleDate(c.toDate)])
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  if (cityDates.length) return { start: cityDates[0], end: cityDates[cityDates.length - 1] };

  return { start: null, end: null };
}

/**
 * 計画1件から訪問地と地図ピンを取り出す。
 * 都市（route cities）だけでなく、行程に登録された全ての場所を対象にする。
 * 同名の場所はまとめ（最も新しい訪問日を保持）、地点名ごとにピンを1つ作る。
 */
function destinationsOf(itinerary: ItineraryItem[], cities: RouteCity[]): { places: string[]; points: TripPoint[] } {
  const places: string[] = [];
  const seenPlace = new Set<string>();
  const points: TripPoint[] = [];
  const pointByName = new Map<string, TripPoint>();

  const addPlace = (name: string): void => {
    if (name && !seenPlace.has(name)) {
      seenPlace.add(name);
      places.push(name);
    }
  };

  // 1地点を登録。座標は「行程の緯度経度」→「地名→座標テーブル」の順で解決。
  const consider = (rawName: string | undefined, lat: number, lng: number, date: Date | null, fallbackArea?: string): void => {
    const name = String(rawName || "").trim();
    if (!name) return;
    addPlace(name);

    let coordLat = lat;
    let coordLng = lng;
    if (!Number.isFinite(coordLat) || !Number.isFinite(coordLng)) {
      const geo = TripPlans.coordsFor(name) || (fallbackArea ? TripPlans.coordsFor(fallbackArea) : null);
      if (!geo) return;
      coordLat = geo.lat;
      coordLng = geo.lng;
    }

    const existing = pointByName.get(name);
    if (existing) {
      if (date && (!existing.date || date.getTime() > existing.date.getTime())) existing.date = date;
      return;
    }
    const point: TripPoint = { lat: coordLat, lng: coordLng, label: name, date: date || undefined };
    pointByName.set(name, point);
    points.push(point);
  };

  // 行程の全アイテム（具体的な場所名 place、無ければ area）。
  for (const it of itinerary) {
    consider(it.place || it.area, num(it.lat), num(it.lng), parseFlexibleDate(it.date), it.area);
  }
  // 行程に現れない都市があれば補う。
  for (const c of cities) {
    consider(c.name, num(c.lat), num(c.lng), parseFlexibleDate(c.fromDate));
  }

  return { places, points };
}

/**
 * その名前が参加している旅行の履歴を、新しい順（期間の開始が新しいものが先、日付不明は末尾）で返す。
 */
export function personTrips(name: string, userId = ""): PersonTrip[] {
  const target = String(name || "").trim();
  if (!target) return [];

  const trips: PersonTrip[] = TripPlans.list()
    .filter((plan) => userId ? Boolean(plan.memberIds?.includes(userId)) : splitNames(plan.members).includes(target))
    .map((plan) => {
      const data = TripPlans.getData(plan.slug);
      const itinerary = (data?.itinerary || []) as ItineraryItem[];
      const cities = (data?.cities || []) as RouteCity[];
      const { start, end } = rangeOf(plan, itinerary, cities);
      const { places, points } = destinationsOf(itinerary, cities);
      // 日付が無い地点は旅行の開始日で補完し、期間フィルターの対象にできるようにする。
      const fallbackDate = start || end || null;
      if (fallbackDate) points.forEach((p) => { if (!p.date) p.date = fallbackDate; });
      return { plan, start, end, places, points };
    });

  return trips.sort((a, b) => {
    if (a.start && b.start) return b.start.getTime() - a.start.getTime();
    if (a.start) return -1;
    if (b.start) return 1;
    return 0;
  });
}

/** ある地点への1回の訪問（どの旅行で・いつ・前後どこへ行ったか）。 */
export interface PinVisit {
  tripTitle: string;
  tripSlug: string;
  date?: Date;
  /** この地点の直前に訪れた場所（同じ旅行内）。 */
  prevPlace?: string;
  /** この地点の後に訪れた場所（同じ旅行内）。 */
  nextPlace?: string;
}

/** 履歴全体の地図ピン（全旅行の地点を地名でまとめる）。訪問の内訳を visits に持つ。 */
export interface HistoryPin extends LatLng {
  place: string;
  /** その地点の最新訪問日（期間フィルター・地図ラベルに使う）。 */
  date?: Date;
  /** 訪問の内訳（日付の古い順）。 */
  visits: PinVisit[];
}

export function historyPins(trips: PersonTrip[]): HistoryPin[] {
  const byName = new Map<string, HistoryPin>();
  for (const trip of trips) {
    const title = trip.plan.title || "旅行";
    // points は行程順（初出順）＝訪問順。前後の場所はこの並びから取る。
    const pts = trip.points;
    pts.forEach((pt, i) => {
      let pin = byName.get(pt.label);
      if (!pin) {
        pin = { lat: pt.lat, lng: pt.lng, place: pt.label, date: pt.date, visits: [] };
        byName.set(pt.label, pin);
      }
      if (pt.date && (!pin.date || pt.date.getTime() > pin.date.getTime())) pin.date = pt.date;
      pin.visits.push({
        tripTitle: title,
        tripSlug: trip.plan.slug,
        date: pt.date,
        prevPlace: i > 0 ? pts[i - 1].label : undefined,
        nextPlace: i < pts.length - 1 ? pts[i + 1].label : undefined,
      });
    });
  }
  // 各ピンの訪問を日付の古い順に並べる（日付なしは末尾）。
  const pins = Array.from(byName.values());
  pins.forEach((pin) => {
    pin.visits.sort((a, b) => {
      if (a.date && b.date) return a.date.getTime() - b.date.getTime();
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });
  });
  return pins;
}

/** ピンに紐づく国の一覧を、訪問地数の多い順で返す（訪問国数・国旗表示に使う）。 */
export function countriesFromPins(pins: HistoryPin[]): { name: string; flag: string; count: number }[] {
  const map = new Map<string, { name: string; flag: string; count: number }>();
  for (const pin of pins) {
    const c = countryOf(pin.lat, pin.lng);
    if (!c) continue;
    const existing = map.get(c.name);
    if (existing) existing.count += 1;
    else map.set(c.name, { name: c.name, flag: c.flag, count: 1 });
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}

/** 訪問した土地の総数（重複なし）。 */
export function distinctPlaceCount(trips: PersonTrip[]): number {
  const set = new Set<string>();
  trips.forEach((t) => t.places.forEach((p) => set.add(p)));
  return set.size;
}
