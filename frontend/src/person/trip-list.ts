import { escapeHtml } from "../shared/dom";
import { icon } from "../shared/icons";
import type { PersonTrip } from "../shared/travel-history";
import { personName, $ } from "./context";
import { tripDays, tripFlags, tripYear, tripDateRange } from "./trip-summary";

export function renderTrips(trips: PersonTrip[]): void {
  const listEl = $("[data-trips]");
  const countEl = $("[data-trips-count]");
  if (countEl) countEl.textContent = trips.length ? `${trips.length}件` : "";
  if (!listEl) return;

  if (!trips.length) {
    listEl.innerHTML = `<div class="pv-empty"><b>まだ旅行がありません</b><span>${escapeHtml(personName)}さんが参加している計画がここに並びます</span></div>`;
    return;
  }

  const groups = new Map<string, PersonTrip[]>();
  for (const trip of trips) {
    const year = tripYear(trip);
    groups.set(year, [...(groups.get(year) || []), trip]);
  }

  listEl.innerHTML = Array.from(groups.entries())
    .map(([year, yearTrips]) => {
      const rows = yearTrips
        .map((trip) => {
          const days = tripDays(trip);
          const flags = tripFlags(trip);
          const route = trip.places.join("・");
          return (
            `<a class="pv-trip" href="index.html?plan=${encodeURIComponent(trip.plan.slug)}">` +
            `<span class="pv-trip-date">${icon("calendarDays")}${escapeHtml(tripDateRange(trip))}</span>` +
            `<span class="pv-trip-main">` +
            `<span class="pv-trip-name">${escapeHtml(trip.plan.title || "無題の旅行")}` +
            (flags ? `<span class="pv-trip-flags">${flags}</span>` : "") +
            `</span>` +
            `<span class="pv-trip-meta">` +
            (route ? `<span>${icon("mapPin")}${escapeHtml(route)}</span>` : "") +
            (days ? `<span>${icon("clock")}${days}日</span>` : "") +
            `</span>` +
            `</span>` +
            `<span class="pv-trip-open">${icon("chevronRight")}</span>` +
            `</a>`
          );
        })
        .join("");
      return `<section class="pv-trip-year-group"><h3 class="pv-trip-year">${escapeHtml(year)}</h3><div class="pv-trip-year-list">${rows}</div></section>`;
    })
    .join("");
}
