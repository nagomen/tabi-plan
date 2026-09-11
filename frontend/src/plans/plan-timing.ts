import type { PlanMeta } from "../shared/plans-store";
import { updatedTimestamp } from "../shared/date";

export type PlanTiming = "current" | "upcoming" | "past" | "undated";

function dayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function parseLooseDate(token: string, fallbackYear?: number): Date | null {
  const match = token.match(/(?:(\d{4})[\/.-])?\s*(\d{1,2})[\/.-](\d{1,2})/);
  if (!match) return null;
  const year = match[1] ? Number(match[1]) : fallbackYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateRange(meta: PlanMeta): { start: number; end: number } | null {
  const raw = String(meta.dates || "");
  if (!raw.trim()) return null;
  const parts = raw.split(/\s*(?:-|–|—|〜|~|から|to)\s*/).filter(Boolean);
  const startDate = parseLooseDate(parts[0] || raw);
  if (!startDate) return null;
  const endDate = parseLooseDate(parts[1] || "", startDate.getFullYear()) || startDate;
  return { start: dayStart(startDate), end: dayStart(endDate) };
}

function planTiming(meta: PlanMeta, today = dayStart(new Date())): { kind: PlanTiming; distance: number } {
  const range = dateRange(meta);
  if (!range) return { kind: "undated", distance: Number.POSITIVE_INFINITY };
  if (range.start <= today && today <= range.end) return { kind: "current", distance: 0 };
  if (today < range.start) return { kind: "upcoming", distance: range.start - today };
  return { kind: "past", distance: today - range.end };
}

export function sortMinePlans(plans: PlanMeta[]): PlanMeta[] {
  const rank: Record<PlanTiming, number> = { current: 0, upcoming: 1, undated: 2, past: 3 };
  return [...plans].sort((a, b) => {
    const ta = planTiming(a);
    const tb = planTiming(b);
    if (rank[ta.kind] !== rank[tb.kind]) return rank[ta.kind] - rank[tb.kind];
    if (ta.distance !== tb.distance) return ta.distance - tb.distance;
    return updatedTimestamp(b) - updatedTimestamp(a);
  });
}

export function highlightedMineSlugs(plans: PlanMeta[]): Map<string, PlanTiming> {
  const result = new Map<string, PlanTiming>();
  plans.forEach((meta) => {
    if (planTiming(meta).kind === "current") result.set(meta.slug, "current");
  });
  if (!result.size) {
    const next = plans.find((meta) => planTiming(meta).kind === "upcoming");
    if (next) result.set(next.slug, "upcoming");
  }
  return result;
}
