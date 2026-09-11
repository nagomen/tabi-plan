import type { PersonTrip } from "../shared/travel-history";
import { monthCalendarHtml, bandColor } from "../shared/calendar";
import { $, today } from "./context";

interface Band { plan: PersonTrip["plan"]; start: Date; end: Date; color: string }

export const view = { year: today.getFullYear(), month: today.getMonth() };
let bands: Band[] = [];

export function renderCalendar(trips: PersonTrip[], allSlugs: string[]): void {
  bands = trips
    .filter((t): t is PersonTrip & { start: Date; end: Date } => Boolean(t.start && t.end))
    .map((t) => ({ plan: t.plan, start: t.start, end: t.end, color: bandColor(t.plan.slug, allSlugs) }));

  // 直近の旅行がある月を初期表示にする。
  if (bands.length) {
    const latest = bands.reduce((a, b) => (b.start.getTime() > a.start.getTime() ? b : a));
    view.year = latest.start.getFullYear();
    view.month = latest.start.getMonth();
  }
  drawCalendar();
}

export function drawCalendar(): void {
  const calEl = $("[data-cal]");
  const titleEl = $("[data-cal-title]");
  if (titleEl) titleEl.textContent = `${view.year}年${view.month + 1}月`;
  if (!calEl) return;

  calEl.innerHTML = monthCalendarHtml({
    year: view.year,
    month: view.month,
    today,
    classPrefix: "pv",
    bands: bands.map((band) => ({
      slug: band.plan.slug,
      title: band.plan.title || "旅行",
      start: band.start,
      end: band.end,
      color: band.color,
    })),
  });
}
