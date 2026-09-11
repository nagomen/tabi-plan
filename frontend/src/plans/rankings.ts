import type { PlanMeta } from "../shared/plans-store";
import { updatedTimestamp } from "../shared/date";
import { getViews } from "../shared/views-store";
import { rankingNewEl, rankingViewsEl, newCountEl, viewsTotalEl } from "./dom";
import { setLastRankingLimit } from "./state";
import { emptyList, rowHtml } from "./plan-card";

export function rankingCardLimit(): number {
  const width = Math.max(
    rankingNewEl.clientWidth,
    rankingViewsEl.clientWidth,
    Math.min(window.innerWidth, 1600) - 48,
  );
  const cardWidth = window.innerWidth <= 600 ? 180 : 220;
  const gap = window.innerWidth <= 600 ? 12 : 18;
  return Math.max(5, Math.min(12, Math.ceil((width + gap) / (cardWidth + gap))));
}

export function renderRankings(plans: PlanMeta[]): void {
  const limit = rankingCardLimit();
  setLastRankingLimit(limit);
  const latest = [...plans].sort((a, b) => updatedTimestamp(b) - updatedTimestamp(a)).slice(0, limit);
  const byViews = [...plans].sort((a, b) => getViews(b.slug) - getViews(a.slug) || updatedTimestamp(b) - updatedTimestamp(a)).slice(0, limit);
  // 新着・ランキングも「自分の計画」と同じカードを使う。
  // 以前は discover-trip-card という別実装で、同じ旅行計画なのに
  // 画像サイズ・文字サイズ・情報の並びが揃っていなかった。
  const discoverCard = (meta: PlanMeta, label: string): string =>
    rowHtml(meta, "public", "", undefined, label);

  rankingNewEl.innerHTML = latest.length
    ? latest.map((meta, i) => discoverCard(meta, "NEW " + String(i + 1).padStart(2, "0"))).join("")
    : emptyList("公開旅行はまだありません。最初の旅行を作って公開できます。");
  rankingViewsEl.innerHTML = byViews.length
    ? byViews.map((meta, i) => discoverCard(meta, "No." + String(i + 1) + " / " + getViews(meta.slug).toLocaleString("ja-JP") + " views")).join("")
    : emptyList("観覧数ランキングは、公開旅行が閲覧されると表示されます。");
  newCountEl.textContent = latest.length ? latest.length + "件" : "";
  const totalViews = plans.reduce((sum, meta) => sum + getViews(meta.slug), 0);
  viewsTotalEl.textContent = totalViews ? totalViews.toLocaleString("ja-JP") + " views" : "";
}
