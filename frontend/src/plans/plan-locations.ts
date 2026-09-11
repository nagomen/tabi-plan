import * as TripPlans from "../shared/plans-store";
import type L from "leaflet";
import type { LocalPlanData, PlanMeta } from "../shared/plans-store";
import { planDataCache } from "./state";

export interface LocationEntry {
  name: string;
  coords?: L.LatLngTuple;
}

export interface DestinationRow {
  name: string;
  count: number;
  coords?: L.LatLngTuple;
}

function routeParts(meta: PlanMeta): string[] {
  const source = [meta.route, meta.title].filter(Boolean).join("、");
  return TripPlans.splitRouteLocations(source).slice(0, 8);
}

function destinationName(meta: PlanMeta): string {
  const parts = routeParts(meta);
  if (parts[0]) return parts[0];
  return meta.title.replace(/旅行|計画|ダッシュボード/g, "").trim() || "行き先未定";
}

const LOCATION_ALIASES: [RegExp, string][] = [
  [/羽田|成田|東京駅|品川|新宿|マンハッタン|リバティ島/i, "東京"],
  [/関西国際空港|伊丹|新大阪/i, "大阪"],
  [/京都駅/i, "京都"],
  [/博多/i, "福岡"],
  [/ホノルル/i, "ハワイ"],
  [/london\s*hotel/i, "ロンドン"],
  [/ベルリン|ドイツ/i, "ドイツ"],
  [/バルセロナ|マドリード/i, "スペイン"],
  [/デリー/i, "インド"],
  [/ウランバートル/i, "モンゴル"],
  [/台北/i, "台湾"],
];

function displayLocationName(name: string): string {
  const raw = String(name || "").trim();
  const hit = LOCATION_ALIASES.find(([pattern]) => pattern.test(raw));
  if (hit) return hit[1];
  return raw
    .replace(/国際?空港|空港|駅|ホテル|hotel/gi, "")
    .replace(/\s+/g, " ")
    .trim() || raw;
}

function numeric(value: number | string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function dataForPlan(meta: PlanMeta): LocalPlanData | null {
  if (!planDataCache.has(meta.slug)) {
    planDataCache.set(meta.slug, TripPlans.getData(meta.slug));
  }
  return planDataCache.get(meta.slug) || null;
}

function uniqueLocationEntries(entries: LocationEntry[]): LocationEntry[] {
  const byName = new Map<string, LocationEntry>();
  entries.forEach((entry) => {
    const name = displayLocationName(entry.name);
    if (!name) return;
    const existing = byName.get(name);
    if (!existing || (!existing.coords && entry.coords)) byName.set(name, { name, coords: entry.coords });
  });
  return [...byName.values()];
}

function locationEntries(meta: PlanMeta): LocationEntry[] {
  const data = dataForPlan(meta);
  const entries: LocationEntry[] = (data?.cities || [])
    .map((city) => {
      const lat = numeric(city.lat);
      const lng = numeric(city.lng);
      return {
        name: city.name || "",
        coords: lat !== null && lng !== null ? [lat, lng] as L.LatLngTuple : undefined,
      };
    });

  entries.push(...(data?.itinerary || []).map((item) => ({ name: item.area || "" })));
  entries.push(...routeParts(meta).map((name) => ({ name })));

  const unique = uniqueLocationEntries(entries);
  return unique.length ? unique : uniqueLocationEntries([{ name: destinationName(meta) }]);
}

function locationNames(meta: PlanMeta): string[] {
  return locationEntries(meta).map((entry) => entry.name);
}

export function locationLabel(meta: PlanMeta): string {
  return locationNames(meta).join("、") || meta.route || destinationName(meta);
}

export function compactLocationLabel(meta: PlanMeta, max = 3): string {
  const names = locationNames(meta).slice(0, max);
  return names.join("、") || meta.route || destinationName(meta);
}

function hasLocation(meta: PlanMeta, location: string): boolean {
  return locationNames(meta).includes(location);
}

export function plansForLocation(plans: PlanMeta[], location: string): PlanMeta[] {
  return plans.filter((meta) => hasLocation(meta, location));
}

export function destinationRows(plans: PlanMeta[]): DestinationRow[] {
  const rows = new Map<string, DestinationRow>();
  plans.forEach((meta) => {
    locationEntries(meta).forEach((entry) => {
      const row = rows.get(entry.name) || { name: entry.name, count: 0 };
      row.count += 1;
      if (!row.coords && entry.coords) row.coords = entry.coords;
      rows.set(entry.name, row);
    });
  });
  return [...rows.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
}
