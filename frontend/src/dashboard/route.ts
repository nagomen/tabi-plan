import { escapeHtml } from "../shared/dom";
import { mdLabel } from "../shared/date";
import { hooks, leafletState, state } from "./state";
import { qsa, setHtml } from "./dom";

// ---- ルート（滞在都市セグメント） --------------------------------------

const ROUTE_PALETTE = ["#0b5a42", "#22719d", "#b87418", "#6246a6", "#cf4f3d", "#2f7d6b", "#8a5a2b", "#3b4c8a"];

interface RouteSeg {
  name: string;
  fromDate: string;
  toDate: string;
  firstDayIndex: number;
  nights: number;
  color: string;
}

function nightsBetween(from: string, to: string): number {
  const a = new Date(from);
  const b = new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86400000));
}

// 滞在都市セグメントを算出。cities があればそれ、無ければ各日 area の連続区間。
export function computeRoute(): { segs: RouteSeg[]; dayToSeg: number[] } {
  const days = state.days;
  const dayToSeg: number[] = new Array(days.length).fill(-1);
  const segs: RouteSeg[] = [];
  const cities = (state.data.cities || []).filter((c) => c.name && c.fromDate && c.toDate);

  if (cities.length) {
    cities.forEach((c, i) =>
      segs.push({
        name: c.name,
        fromDate: c.fromDate,
        toDate: c.toDate,
        firstDayIndex: -1,
        nights: nightsBetween(c.fromDate, c.toDate),
        color: ROUTE_PALETTE[i % ROUTE_PALETTE.length],
      }),
    );
    days.forEach((day, di) => {
      // その日をカバーする都市のうち、開始日が最も新しい（=現在地）ものに割り当て
      let best = -1;
      let bestFrom = "";
      cities.forEach((c, ci) => {
        if (c.fromDate <= day.date && day.date <= c.toDate && c.fromDate >= bestFrom) {
          best = ci;
          bestFrom = c.fromDate;
        }
      });
      dayToSeg[di] = best;
    });
    segs.forEach((s, si) => {
      const idx = dayToSeg.indexOf(si);
      s.firstDayIndex = idx >= 0 ? idx : 0;
    });
  } else {
    let prev: string | null = null;
    days.forEach((day, di) => {
      const area = (day.area || "").trim();
      if (!area) {
        dayToSeg[di] = segs.length ? segs.length - 1 : -1;
        return;
      }
      if (area !== prev) {
        segs.push({
          name: area,
          fromDate: day.date,
          toDate: day.date,
          firstDayIndex: di,
          nights: 0,
          color: ROUTE_PALETTE[segs.length % ROUTE_PALETTE.length],
        });
        prev = area;
      }
      const seg = segs[segs.length - 1];
      seg.toDate = day.date;
      seg.nights = nightsBetween(seg.fromDate, seg.toDate);
      dayToSeg[di] = segs.length - 1;
    });
  }
  return { segs, dayToSeg };
}

function jumpToDay(index: number): void {
  state.active = index;
  state.viewEnd = index; // 日を切り替えたらフィードは1日だけに戻す
  leafletState.followActive = true;
  hooks.renderActive();
}

export function renderDayTabs(route: { segs: RouteSeg[]; dayToSeg: number[] }): void {
  const dayTab = (day: (typeof state.days)[number], index: number, withArea: boolean): string =>
    `<button class="tl-day" type="button" data-day-index="${index}" aria-selected="${index === state.active}">` +
    `<b>${escapeHtml(day.day || `Day ${index + 1}`)}${withArea ? `<br>${escapeHtml(day.area || "")}` : ""}</b>` +
    `<small>${escapeHtml(mdLabel(day.date))}</small></button>`;

  if (route.segs.length >= 2) {
    let html = "";
    let cur = -2;
    state.days.forEach((day, index) => {
      const seg = route.dayToSeg[index];
      if (seg !== cur) {
        if (cur !== -2) html += "</div></div>";
        const s = route.segs[seg];
        html += `<div class="tl-daygroup" style="--c:${s ? s.color : "#68746e"}">` +
          `<span class="tl-daygroup-label">${escapeHtml(s ? s.name : "—")}</span><div class="tl-daygroup-days">`;
        cur = seg;
      }
      html += dayTab(day, index, false);
    });
    if (cur !== -2) html += "</div></div>";
    setHtml("[data-days]", html);
  } else {
    setHtml("[data-days]", state.days.map((day, index) => dayTab(day, index, true)).join(""));
  }

  qsa<HTMLElement>("[data-day-index]").forEach((button) => {
    button.addEventListener("click", () => jumpToDay(Number(button.dataset.dayIndex)));
  });
}
