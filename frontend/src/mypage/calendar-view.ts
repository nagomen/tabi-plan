import { escapeHtml } from "../shared/dom";
import { mdOf, parseFlexibleDate } from "../shared/date";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { isMemberOf } from "../shared/membership";
import { monthCalendarHtml, bandColor, stepMonth } from "../shared/calendar";

// ---- 日付ユーティリティ -------------------------------------------------

interface PlanRange { start: Date; end: Date }

/** 計画の期間を {start,end} で返す。行程の日付があれば最小〜最大、無ければ meta.dates を解析。 */
function planRange(plan: PlanMeta): PlanRange | null {
  const data = TripPlans.getData(plan.slug);
  const dates = (data?.itinerary || [])
    .map((it) => parseFlexibleDate(it.date))
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => a.getTime() - b.getTime());
  if (dates.length) return { start: dates[0], end: dates[dates.length - 1] };
  const parts = String(plan.dates || "")
    .split(/[-–—〜~]/)
    .map((s) => parseFlexibleDate(s.trim()))
    .filter((d): d is Date => Boolean(d));
  if (parts.length) return { start: parts[0], end: parts[parts.length - 1] };
  return null;
}

export interface CalendarEls {
  calMount: HTMLElement;
  calTitle: HTMLElement;
  calLegend: HTMLElement;
  calPrev: HTMLButtonElement;
  calNext: HTMLButtonElement;
}

// ---- カレンダー（全計画の日程） ----------------------------------------

export function mountCalendar(els: CalendarEls): { renderCalendar: () => void } {
  const { calMount, calTitle, calLegend, calPrev, calNext } = els;
  const today = new Date();
  const view = { year: today.getFullYear(), month: today.getMonth() };

  interface PlanBand { plan: PlanMeta; range: PlanRange; color: string }

  function renderCalendar(): void {
    const all = TripPlans.list();
    const allSlugs = all.map((p) => p.slug);
    // カレンダーも「自分が参加している計画のみ」。
    const mine = all.filter(isMemberOf);
    const bands: PlanBand[] = mine
      .map((plan) => {
        const range = planRange(plan);
        return range ? { plan, range, color: bandColor(plan.slug, allSlugs) } : null;
      })
      .filter((b): b is PlanBand => Boolean(b));

    calTitle.textContent = `${view.year}年${view.month + 1}月`;

    calMount.innerHTML = monthCalendarHtml({
      year: view.year,
      month: view.month,
      today,
      classPrefix: "mp",
      bands: bands.map((band) => ({
        slug: band.plan.slug,
        title: band.plan.title || "旅行",
        start: band.range.start,
        end: band.range.end,
        color: band.color,
      })),
    });

    // 凡例: 表示中の月に重なる計画
    const monthStart = new Date(view.year, view.month, 1).getTime();
    const monthEnd = new Date(view.year, view.month + 1, 0).getTime();
    const inMonth = bands.filter((b) => {
      const s = new Date(b.range.start.getFullYear(), b.range.start.getMonth(), b.range.start.getDate()).getTime();
      const e = new Date(b.range.end.getFullYear(), b.range.end.getMonth(), b.range.end.getDate()).getTime();
      return e >= monthStart && s <= monthEnd;
    });
    calLegend.innerHTML = inMonth.length
      ? inMonth
          .map(
            (b) =>
              `<a class="mp-legend-row" href="index.html?plan=${encodeURIComponent(b.plan.slug)}">` +
              `<span class="mp-legend-sw" style="background:${b.color}"></span>` +
              `<span class="mp-legend-name">${escapeHtml(b.plan.title || "無題の旅行")}</span>` +
              `<span class="mp-legend-dates">${mdOf(b.range.start)}〜${mdOf(b.range.end)}</span>` +
              `</a>`,
          )
          .join("")
      : `<div class="mp-empty"><b>この月の旅行はありません</b><span>前後の月も確認してください</span></div>`;
  }

  calPrev.addEventListener("click", () => { stepMonth(view, -1); renderCalendar(); });
  calNext.addEventListener("click", () => { stepMonth(view, 1); renderCalendar(); });

  return { renderCalendar };
}
