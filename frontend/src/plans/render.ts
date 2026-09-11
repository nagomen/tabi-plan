import * as TripPlans from "../shared/plans-store";
import { readGlobalTripConfig } from "../shared/config";
import { icon } from "../shared/icons";
import { isIdentified } from "../shared/identity";
import {
  gridMine,
  gridPublic,
  discoverSectionEl,
  toolbarEl,
  mineHeadEl,
  publicHead,
  countEl,
  countMineEl,
  countPublicEl,
  inviteStripEl,
} from "./dom";
import { state, planDataCache } from "./state";
import { sortMinePlans, highlightedMineSlugs } from "./plan-timing";
import { rowHtml, matchesFilter } from "./plan-card";
import { renderDiscover } from "./location-explorer";
import { renderStart, newPlanHref } from "./new-plan";

const EMPTY_TRIP_COVERS = [
  "./images/thumbs/cover_tokyo.webp",
  "./images/thumbs/cover_newyork.webp",
  "./images/thumbs/cover_africa.webp",
  "./images/thumbs/cover_india.webp",
  "./images/thumbs/cover_arizona.webp",
];

const emptyTripCover = EMPTY_TRIP_COVERS[Math.floor(Math.random() * EMPTY_TRIP_COVERS.length)];

export function render(): void {
  TripPlans.ensureSeed(readGlobalTripConfig());
  planDataCache.clear();
  const activeSlug = TripPlans.getActiveSlug();
  const filter = state.filter.trim().toLowerCase();
  // 「自分の計画」は本人が確定していれば出す。
  // 旧構造はアカウントのログイン有無で出し分けていたが、いまは identity（user_id）が正。
  const loggedIn = isIdentified();

  const all = TripPlans.list();
  const mine = loggedIn ? sortMinePlans(TripPlans.listMine().filter((m) => matchesFilter(m, filter))) : [];
  const others = TripPlans.listPublic().filter((m) => matchesFilter(m, filter));
  const discoverPlans = all.filter((m) => TripPlans.isPublished(m) && TripPlans.planVisibility(m) === "public" && m.source !== "sample");
  const mineHighlights = highlightedMineSlugs(mine);

  const mineTotal = TripPlans.listMine().length;
  if (loggedIn) {
    inviteStripEl.after(toolbarEl);
    toolbarEl.after(mineHeadEl);
    mineHeadEl.after(gridMine);
    gridMine.after(discoverSectionEl);
  } else {
    inviteStripEl.after(discoverSectionEl);
    discoverSectionEl.after(toolbarEl);
    toolbarEl.after(mineHeadEl);
    mineHeadEl.after(gridMine);
  }
  mineHeadEl.hidden = !loggedIn;
  gridMine.hidden = !loggedIn;

  if (countEl) countEl.textContent = mineTotal ? "自分の計画 " + mineTotal + "件" : "計画はまだありません";
  countMineEl.textContent = mine.length ? mine.length + "件" : "";
  renderStart();
  renderDiscover(discoverPlans);

  // --- 自分の計画 ---
  if (!loggedIn) {
    gridMine.innerHTML = "";
    countMineEl.textContent = "";
  } else if (mine.length) {
    gridMine.innerHTML = mine.map((meta) => rowHtml(meta, "mine", activeSlug, mineHighlights.get(meta.slug))).join("");
  } else {
    gridMine.innerHTML =
      '<div class="hub-empty">' +
      (mineTotal
        ? '<div class="hub-empty-simple"><b>該当する計画がありません</b><span>検索条件を変えてください</span></div>'
        : '<div class="hub-empty-layout">' +
          '<span class="hub-empty-tag">' + icon("sparkles") + '<span>FIRST TRIP</span></span>' +
          '<div class="hub-empty-art" aria-hidden="true">' +
          '<img src="' + emptyTripCover + '" alt="">' +
          '<span class="hub-empty-pin start">' + icon("mapPin") + '</span>' +
          '<span class="hub-empty-pin end">' + icon("flag") + '</span>' +
          '<span class="hub-empty-route"></span>' +
          '</div>' +
          '<div class="hub-empty-copy">' +
          '<b>最初の計画を作りましょう</b>' +
          '<span>行き先、日程、メンバーを入れて旅の下書きを始められます</span>' +
          '</div>' +
          '<div class="hub-empty-steps">' +
          '<span>' + icon("mapPin") + '<i>01</i>行き先</span>' +
          '<span>' + icon("calendarDays") + '<i>02</i>日程</span>' +
          '<span>' + icon("listBullet") + '<i>03</i>行程</span>' +
          '</div>' +
          '<a class="hub-empty-cta" href="' + newPlanHref() + '">' + icon("plusCircle") + '<span>新規計画を作る</span></a>' +
          '</div>') +
      "</div>";
  }

  // --- みんなの公開計画（0件のときはセクションごと隠す） ---
  if (others.length) {
    gridPublic.innerHTML = others.map((meta) => rowHtml(meta, "public", activeSlug)).join("");
    countPublicEl.textContent = others.length + "件";
    publicHead.hidden = false;
    gridPublic.hidden = false;
  } else {
    gridPublic.innerHTML = "";
    countPublicEl.textContent = "";
    publicHead.hidden = true;
    gridPublic.hidden = true;
  }
}
