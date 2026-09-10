import * as TripPlans from "../shared/plans-store";
import type { LocalPlanData, PlanMeta } from "../shared/plans-store";
import { escapeHtml } from "../shared/dom";
import { mdLabel } from "../shared/date";
import { mapsSearchUrl } from "../shared/maps";
import { icon, type IconName } from "../shared/icons";
import { canEditPlan } from "../shared/membership";
import { locationScheduleEl, mapBoardEl } from "./dom";
import { emptyList, planHref } from "./plan-card";
import { locationLabel } from "./plan-locations";

function itineraryFor(meta: PlanMeta | undefined): LocalPlanData | null {
  if (!meta) return null;
  return TripPlans.getData(meta.slug);
}

function itemTitle(item: LocalPlanData["itinerary"][number]): string {
  return item.title || item.place || item.area || item.destination || item.origin || "予定";
}

const SCHEDULE_KIND_ICON: Record<string, IconName> = {
  sight: "camera",
  food: "cake",
  move: "arrowsRightLeft",
  stay: "buildingOffice2",
  todo: "check",
  form: "documentText",
};

function scheduleKindClass(type: string | undefined): string {
  const normalized = String(type || "todo");
  return SCHEDULE_KIND_ICON[normalized] ? normalized : "todo";
}

function scheduleKindIcon(type: string | undefined): string {
  return icon(SCHEDULE_KIND_ICON[String(type || "")] || "check");
}

function scheduleMapLink(query: string | undefined): string {
  return '<a class="schedule-maplink" href="' + mapsSearchUrl(query) + '" target="_blank" rel="noopener">地図 ' +
    icon("arrowTopRightOnSquare") + '</a>';
}

function scheduleMetaText(item: LocalPlanData["itinerary"][number]): string {
  const title = itemTitle(item);
  const place = item.place && item.place !== title ? "場所: " + item.place : "";
  const move = String(item.type) === "move" ? [item.transport, item.duration].filter(Boolean).join("・") : "";
  return [move || place, item.note].filter(Boolean).join(" / ");
}

function scheduleDayHead(rows: LocalPlanData["itinerary"], index: number): string {
  const first = rows[0];
  const day = first?.day || "Day " + (index + 1);
  const area = first?.area || "";
  const date = mdLabel(first?.date);
  const title = [day, area, date].filter(Boolean).join(" ・ ");
  const weather = rows.find((row) => row.weather)?.weather || "";
  return '<div class="schedule-dayblock-head"><b>' + escapeHtml(title || "日程") + '</b>' +
    (weather ? '<span class="schedule-weather">' + escapeHtml(weather) + '</span>' : "") + '</div>';
}

function scheduleStayHtml(item: LocalPlanData["itinerary"][number]): string {
  const title = itemTitle(item) || "宿泊先";
  const place = item.place && item.place !== title ? item.place : "";
  return '<div class="schedule-stay">' +
    '<span class="schedule-stay-ic">' + icon("buildingOffice2") + '</span>' +
    '<div class="schedule-stay-body">' +
    '<span class="schedule-stay-label">' + escapeHtml(item.typeLabel || "宿泊") + '</span>' +
    '<span class="schedule-stay-name">' + escapeHtml(title) + '</span>' +
    (place ? '<span class="schedule-stay-place">' + escapeHtml(place) + '</span>' : "") +
    '</div>' +
    scheduleMapLink(item.mapQuery || item.place || title) +
    '</div>';
}

function scheduleItemHtml(item: LocalPlanData["itinerary"][number]): string {
  const type = String(item.type || "todo");
  const kind = scheduleKindClass(type);
  const label = '<span class="schedule-kind ' + kind + '">' +
    escapeHtml(item.typeLabel || type || "予定") + '</span>';
  let segA = item.origin || "";
  let segB = item.destination || "";
  if (kind === "move" && (!segA || !segB) && /→|->/.test(item.title || "")) {
    const parts = (item.title || "").split(/→|->/);
    segA = segA || (parts[0] || "").trim();
    segB = segB || (parts[1] || "").trim();
  }
  const title = kind === "move" && (segA || segB)
    ? '<div class="schedule-seg"><span>' + escapeHtml(segA || "出発") + '</span>' +
      '<span class="schedule-seg-arr">' + icon("arrowLongRight") + '</span>' +
      '<span>' + escapeHtml(segB || "到着") + '</span></div>'
    : '<h3>' + escapeHtml(itemTitle(item)) + '</h3>';
  const meta = scheduleMetaText(item);
  return '<article class="schedule-tl-item" data-kind="' + kind + '">' +
    '<time class="schedule-time">' + escapeHtml(item.time || "") + '</time>' +
    '<span class="schedule-rail"><span class="schedule-dot ' + kind + '">' + scheduleKindIcon(type) + '</span></span>' +
    '<div class="schedule-plan">' +
    '<div class="schedule-plan-line">' + label + title + '</div>' +
    (item.needed ? '<p class="schedule-needed">' + escapeHtml(item.needed) + '</p>' : "") +
    '<p class="schedule-meta">' +
    (meta ? '<span class="schedule-meta-text">' + escapeHtml(meta) + '</span>' : "") +
    scheduleMapLink(item.mapQuery || item.place || item.title) +
    '</p>' +
    '</div>' +
    '</article>';
}

export function renderSchedule(plan: PlanMeta | undefined): void {
  mapBoardEl.hidden = true;
  locationScheduleEl.hidden = false;
  if (!plan) {
    locationScheduleEl.innerHTML = emptyList("旅行計画を選択してください。");
    return;
  }
  const data = itineraryFor(plan);
  const items = data?.itinerary || [];
  const head =
    '<div class="schedule-head"><span class="schedule-head-ic">' + icon("calendarDays") + '</span>' +
    '<div class="schedule-head-main"><span class="schedule-head-kicker">Itinerary</span>' +
    '<b>' + escapeHtml(plan.title || "無題の旅行") + '</b>' +
    '<span class="schedule-head-meta">' + escapeHtml([plan.dates, locationLabel(plan)].filter(Boolean).join(" ・ ") || "日程情報") + '</span></div>' +
    '<a href="' + planHref(plan, !canEditPlan(plan)) + '">旅行計画を開く ' + icon("arrowTopRightOnSquare") + '</a></div>';
  if (!items.length) {
    locationScheduleEl.innerHTML = head + emptyList("この計画の日程データはまだありません。");
    return;
  }
  const groups = new Map<string, typeof items>();
  items.forEach((item) => {
    const key = [item.date, item.day].filter(Boolean).join(" ") || "日程未設定";
    const arr = groups.get(key) || [];
    arr.push(item);
    groups.set(key, arr);
  });
  locationScheduleEl.innerHTML = head + '<div class="schedule-list">' +
    [...groups.values()].map((rows, index) =>
      '<section class="schedule-dayblock">' +
      scheduleDayHead(rows, index) +
      rows.filter((item) => String(item.type) === "stay").map(scheduleStayHtml).join("") +
      '<div class="schedule-timeline">' +
      rows.filter((item) => String(item.type) !== "stay").map(scheduleItemHtml).join("") +
      '</div>' +
      '</section>',
    ).join("") +
    '</div>';
}
