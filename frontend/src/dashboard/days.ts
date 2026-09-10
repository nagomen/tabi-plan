import * as TripPlans from "../shared/plans-store";
import { normalizeDate, numberOrNaN } from "./api-data-source";
import type { DayGroup } from "./types";
import { localDateISO, parseISO, toISO } from "../shared/date";
import type { TripData, ItineraryItem, LatLng } from "../shared/types";
import { CONFIG, state } from "./state";

// ---- 日付ユーティリティ -------------------------------------------------

export function todayISO(): string {
  return localDateISO(CONFIG.todayOverride);
}

/** 現在時刻を分（0-1439）で返す。 */
export function nowMinutes(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export function nowHM(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" を分に変換（解析不可なら null）。 */
export function timeToMinutes(time: string | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time || "").trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分差を「あとN分 / あとN時間M分」の形にする。 */
export function untilLabel(minutes: number): string {
  if (minutes <= 0) return "まもなく";
  if (minutes < 60) return `あと${minutes}分`;
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return mm ? `あと${h}時間${mm}分` : `あと${h}時間`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

export function tripDateRange(data: TripData): string[] {
  const datesText = String(data.trip?.dates || "");
  const parts = datesText.split(/\s+-\s+/);
  let start = normalizeDate(parts[0]);
  let end = normalizeDate(parts[1] || parts[0]);
  if (start && end && /^\d{1,2}-\d{1,2}$/.test(end)) {
    end = normalizeDate(`${start.slice(0, 4)}-${end}`);
  }
  if ((!start || !end) && data.cities && data.cities.length) {
    const cityDates = data.cities.flatMap((city) => [normalizeDate(city.fromDate), normalizeDate(city.toDate)]).filter(Boolean).sort();
    start = start || cityDates[0] || "";
    end = end || cityDates[cityDates.length - 1] || "";
  }
  const a = parseISO(start);
  const b = parseISO(end);
  if (!a || !b || b < a) return [];
  const dates: string[] = [];
  let cursor = a;
  let guard = 0;
  while (cursor <= b && guard < 400) {
    dates.push(toISO(cursor));
    cursor = addDays(cursor, 1);
    guard++;
  }
  return dates;
}

function cityNameForDate(data: TripData, date: string): string {
  const cities = data.cities || [];
  let current = "";
  let currentFrom = "";
  cities.forEach((city) => {
    const from = normalizeDate(city.fromDate);
    const to = normalizeDate(city.toDate);
    if (city.name && from && to && from <= date && date <= to && from >= currentFrom) {
      current = city.name;
      currentFrom = from;
    }
  });
  return current;
}

export function groupDays(itinerary: ItineraryItem[], data: TripData = state.data): DayGroup[] {
  const map = new Map<string, DayGroup>();
  itinerary
    .map((item) => ({ ...item, date: normalizeDate(item.date), lat: numberOrNaN(item.lat), lng: numberOrNaN(item.lng) }))
    .forEach((item) => {
      const key = item.date || "undated";
      if (!map.has(key)) {
        map.set(key, { date: key, day: item.day || "", area: item.area || item.place || "", weather: item.weather || "", items: [] });
      }
      const day = map.get(key)!;
      day.items.push(item);
      day.day = day.day || item.day || "";
      day.area = day.area || item.area || item.place || "";
      day.weather = day.weather || item.weather || "";
    });
  tripDateRange(data).forEach((date) => {
    if (!map.has(date)) {
      map.set(date, { date, day: "", area: cityNameForDate(data, date), weather: "", items: [] });
    }
  });
  return Array.from(map.values())
    .sort((a, b) => {
      if (a.date === "undated") return 1;
      if (b.date === "undated") return -1;
      return a.date.localeCompare(b.date);
    })
    .map((day, index) => ({
      ...day,
      day: day.day || `Day ${index + 1}`,
      area: day.area || cityNameForDate(data, day.date),
    }));
}

export function chooseActive(days: DayGroup[]): number {
  const today = todayISO();
  let index = days.findIndex((day) => day.date === today);
  if (index >= 0) return index;
  index = days.findIndex((day) => day.date > today);
  return index >= 0 ? index : Math.max(0, days.length - 1);
}

/** その日を代表する座標（最初の座標付き予定、無ければ area の地名辞書）。 */
export function dayCoord(day: DayGroup): LatLng | null {
  for (const it of day.items) {
    const la = Number(it.lat);
    const ln = Number(it.lng);
    if (Number.isFinite(la) && Number.isFinite(ln)) return { lat: la, lng: ln };
  }
  return TripPlans.coordsFor(day.area || "");
}
