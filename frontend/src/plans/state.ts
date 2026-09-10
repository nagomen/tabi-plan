import type { LocalPlanData } from "../shared/plans-store";

interface AppState {
  filter: string;
  selectedLocation: string;
  selectedPlanSlug: string;
}

export const state: AppState = { filter: "", selectedLocation: "", selectedPlanSlug: "" };

export const planDataCache = new Map<string, LocalPlanData | null>();

let lastRankingLimit = 0;

export function getLastRankingLimit(): number {
  return lastRankingLimit;
}

export function setLastRankingLimit(value: number): void {
  lastRankingLimit = value;
}
