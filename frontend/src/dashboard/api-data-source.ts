// ダッシュボードのデータ取得層。共有MySQL APIのキャッシュ、またはサンプルを読む。

import * as TripPlans from "../shared/plans-store";
import type { TripConfig } from "../shared/config";
import type { TripData } from "../shared/types";

export function numberOrNaN(value: unknown): number {
  if (value === "" || value === null || value === undefined) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

export function normalizeDate(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim().replace(/\//g, "-");
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return text;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

export function formatYen(value: number): string {
  return value ? "¥" + Math.round(value).toLocaleString("ja-JP") : "未入力";
}

export async function loadData(config: TripConfig, sample: TripData): Promise<TripData> {
  if (config.mode === "local") {
    return TripPlans.toDashboardData(TripPlans.getData(config.tripSlug));
  }
  return sample;
}
