import { WEEKDAYS } from "../shared/date";
import type { PersonTrip } from "../shared/travel-history";
import { countryOf } from "../shared/country";
import { sameDay, fmtMonthDay } from "./date-format";

/** 旅行の日数（開始〜終了、両端含む）。日付不明は0。 */
export function tripDays(trip: PersonTrip): number {
  if (!trip.start || !trip.end) return 0;
  const s = new Date(trip.start.getFullYear(), trip.start.getMonth(), trip.start.getDate()).getTime();
  const e = new Date(trip.end.getFullYear(), trip.end.getMonth(), trip.end.getDate()).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

/** その旅行で訪れた国の国旗（重複なし・訪問順）。 */
export function tripFlags(trip: PersonTrip): string {
  const seen = new Set<string>();
  const flags: string[] = [];
  for (const pt of trip.points) {
    const c = countryOf(pt.lat, pt.lng);
    if (c && !seen.has(c.name)) {
      seen.add(c.name);
      flags.push(c.flag);
    }
  }
  return flags.join("");
}

/** その旅行の年（開始日、無ければ日程文字列の西暦）。 */
export function tripYear(trip: PersonTrip): string {
  if (trip.start) return String(trip.start.getFullYear());
  const m = /(\d{4})/.exec(String(trip.plan.dates || ""));
  return m ? m[1] : "—";
}

export function tripDateRange(trip: PersonTrip): string {
  if (!trip.start) return String(trip.plan.dates || "日付未定");
  if (!trip.end || sameDay(trip.start, trip.end)) return fmtMonthDay(trip.start);
  if (trip.start.getMonth() === trip.end.getMonth()) {
    return `${fmtMonthDay(trip.start)}-${trip.end.getDate()}(${WEEKDAYS[trip.end.getDay()]})`;
  }
  return `${fmtMonthDay(trip.start)}-${fmtMonthDay(trip.end)}`;
}
