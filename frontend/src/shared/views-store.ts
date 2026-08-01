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

// 同じ閲覧の重複計上を防ぐ間隔。リロードや行き来では加算しない。
const DEDUPE_MS = 30 * 60 * 1000;
const SEEN_KEY = "trip-dashboard-views-seen"; // 端末固有の UI 状態なので localStorage 直

/** この端末が最近この計画を数えたか（数えていなければ記録して false を返す）。 */
function alreadyCounted(slug: string): boolean {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const seen = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    const last = typeof seen[slug] === "number" ? seen[slug] : 0;
    const now = Date.now();
    if (now - last < DEDUPE_MS) return true;
    seen[slug] = now;
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    return false;
  } catch {
    return false; // 判定できないときは従来どおり加算する
  }
}

/**
 * 指定計画の閲覧数を 1 増やして新しい値を返す（計画を開いたときに呼ぶ）。
 * 同一端末からの連続閲覧は DEDUPE_MS の間まとめて 1 回として数える。
 */
export function incrementView(slug: string): number {
  if (!slug) return 0;
  if (alreadyCounted(slug)) return getViews(slug);
  const map: ViewMap = { ...allViews() };
  const next = (typeof map[slug] === "number" && map[slug] > 0 ? Math.floor(map[slug]) : 0) + 1;
  map[slug] = next;
  Backend.setJSON(KEY, map);
  return next;
}
