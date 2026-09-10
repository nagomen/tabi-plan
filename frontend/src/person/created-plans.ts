import { escapeHtml } from "../shared/dom";
import { updatedTimestamp } from "../shared/date";
import { icon } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { planCoverThumbnail } from "../shared/cover";
import { getViews } from "../shared/views-store";
import { canEditPlan, canViewPlan, ownerNameOf } from "../shared/membership";
import { personName, $ } from "./context";

function samePerson(a: string | undefined, b: string): boolean {
  return String(a || "").trim().toLowerCase() === b.trim().toLowerCase();
}

function planCreatorName(meta: PlanMeta): string {
  return ownerNameOf(meta);
}

function isCreatedByPerson(meta: PlanMeta): boolean {
  return samePerson(planCreatorName(meta), personName);
}

function canShowCreatedPlan(meta: PlanMeta): boolean {
  if (!TripPlans.isPublished(meta) && !canEditPlan(meta)) return false;
  return canViewPlan(meta);
}

function createdPlanLocations(meta: PlanMeta, max = 3): string {
  const data = TripPlans.getData(meta.slug);
  const names = [
    ...(data?.cities || []).map((city) => city.name || ""),
    ...(data?.itinerary || []).map((item) => item.area || item.place || ""),
    meta.route || "",
  ].flatMap((raw) => TripPlans.splitRouteLocations(raw));
  return Array.from(new Set(names)).slice(0, max).join("、");
}

export function renderCreatedPlans(): void {
  const mount = $("[data-created-plans]");
  const panel = $("[data-created-panel]");
  const countEl = $("[data-created-count]");
  if (!mount) return;

  const plans = TripPlans.list()
    .filter((meta) => isCreatedByPerson(meta) && canShowCreatedPlan(meta))
    .sort((a, b) => updatedTimestamp(b) - updatedTimestamp(a));

  if (countEl) countEl.textContent = plans.length ? `${plans.length}件` : "";
  if (!plans.length) {
    if (panel) panel.hidden = true;
    mount.innerHTML = "";
    return;
  }
  if (panel) panel.hidden = false;

  mount.innerHTML = plans.map((meta) => {
    const locations = createdPlanLocations(meta);
    const views = getViews(meta.slug);
    const href = `index.html?plan=${encodeURIComponent(meta.slug)}${canEditPlan(meta) ? "" : "&view=1"}`;
    const cover = planCoverThumbnail(meta);
    return (
      `<a class="pv-created-card" href="${escapeHtml(href)}">` +
      `<span class="pv-created-cover"><img src="${escapeHtml(cover)}" alt="${escapeHtml(meta.title || "旅行画像")}" loading="lazy"><span class="pv-created-views">${icon("eye")}<span>${views.toLocaleString("ja-JP")}</span></span></span>` +
      `<span class="pv-created-body">` +
      `<span class="pv-created-title">${escapeHtml(meta.title || "無題の旅行")}</span>` +
      `<span class="pv-created-meta">` +
      (meta.dates ? `<span>${icon("calendarDays")}${escapeHtml(meta.dates)}</span>` : "") +
      (locations ? `<span>${icon("mapPin")}${escapeHtml(locations)}</span>` : "") +
      `</span>` +
      `</span>` +
      `</a>`
    );
  }).join("");
}
