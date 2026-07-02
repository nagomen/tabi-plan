// 計画ごとの閲覧数（観覧数）。
// 保存は backend（差し替え口）経由。1キー（trip-dashboard-views）に {slug: 回数} を持つ。
// dev では data/store/trip-dashboard-views.json に write-through され、プール内で共有される。
// 将来 DB 化する際は backend.ts を差し替えるだけでよい。

import * as Backend from "./backend";

const KEY = "trip-dashboard-views";

export type ViewMap = Record<string, number>;

/** 全計画の閲覧数マップ。 */
export function allViews(): ViewMap {
  const value = Backend.getJSON<ViewMap>(KEY, {});
  return value && typeof value === "object" ? value : {};
}

/** 指定計画の閲覧数（未記録は 0）。 */
export function getViews(slug: string): number {
  const n = allViews()[slug];
  return typeof n === "number" && n > 0 ? Math.floor(n) : 0;
}

/** 指定計画の閲覧数を 1 増やして新しい値を返す（計画を開いたときに呼ぶ）。 */
export function incrementView(slug: string): number {
  if (!slug) return 0;
  const map: ViewMap = { ...allViews() };
  const next = (typeof map[slug] === "number" && map[slug] > 0 ? Math.floor(map[slug]) : 0) + 1;
  map[slug] = next;
  Backend.setJSON(KEY, map);
  return next;
}
