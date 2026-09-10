// 旅行計画一覧（プランハブ）ページ。docs/plans.html のインライン IIFE を
// strict TypeScript モジュールへ移行したもの。
// プランの一覧表示・検索・開く/編集/複製/削除を行う。

import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import "../shared/ui.css";
import "./style.css";
import { initPageTransitions, navigateWithPageTransition } from "../shared/page-transition";
import "leaflet/dist/leaflet.css";
import { errorMessage } from "../shared/dom";
import { registerServiceWorker } from "../shared/pwa";
import { icon, type IconName } from "../shared/icons";
import { mountAppHeader } from "../shared/app-header";
import { showToast } from "./toast";
import { type RowVariant } from "./plan-card";
import { rankingCardLimit } from "./rankings";
import { queueLocationTransition } from "./location-explorer";
import { render } from "./render";
import { closeMenus, duplicateToMine, openAuthorPage } from "./plan-actions";
import { handleJoinLink } from "./invite-join";
import { qs, hub, filterEl, destinationsEl, locationHeadEl, locationPlansEl } from "./dom";
import { state, getLastRankingLimit } from "./state";

initPageTransitions();

// ---- DOM 取得ヘルパー ----------------------------------------------------

mountAppHeader({
  kicker: "Travel Plans",
  title: "旅行計画",
  meta: [],
  mobileFixed: true,
  actions: [
    { kind: "button", display: "icon", icon: "magnifyingGlass", label: "計画を検索", attr: "data-toggle-search" },
    { kind: "link", display: "icon", icon: "user", label: "マイページ", href: "mypage.html" },
  ],
});

const searchToggleEl = qs<HTMLButtonElement>("[data-toggle-search]");
let rankingResizeTimer = 0;

// セクション見出しの heroicon を流し込む（HTML 側は data-ic="名前" のみ持つ）
document.querySelectorAll<HTMLElement>("[data-ic]").forEach((el) => {
  const name = el.getAttribute("data-ic");
  if (name) el.insertAdjacentHTML("afterbegin", icon(name as IconName));
});

function setSearchOpen(open: boolean): void {
  hub.classList.toggle("is-search-open", open);
  searchToggleEl.setAttribute("aria-expanded", String(open));
  if (open) window.setTimeout(() => filterEl.focus(), 0);
}

searchToggleEl.setAttribute("aria-expanded", "false");
searchToggleEl.addEventListener("click", () => {
  setSearchOpen(!hub.classList.contains("is-search-open"));
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest(".plan-tools")) return;
  closeMenus();
});

hub.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const authorLink = target.closest<HTMLElement>("[data-author-link]");
  if (authorLink) {
    event.preventDefault();
    event.stopPropagation();
    openAuthorPage(authorLink);
    return;
  }
  const card = target.closest<HTMLElement>("[data-slug]");
  if (!card) return;
  const slug = card.dataset.slug || "";
  const variant = (card.dataset.variant as RowVariant) || "mine";

  const menuButton = target.closest<HTMLButtonElement>("[data-menu]");
  if (menuButton) {
    event.preventDefault();
    const panel = card.querySelector<HTMLElement>("[data-menu-panel]");
    if (!panel) return;
    const willOpen = panel.hidden;
    closeMenus(willOpen ? panel : null);
    panel.hidden = !willOpen;
    menuButton.setAttribute("aria-expanded", String(willOpen));
    return;
  }

  if (target.closest("[data-open]")) {
    TripPlans.setActiveSlug(slug);
    return; // リンク遷移はそのまま
  }
  closeMenus();
  if (target.closest("[data-edit]")) {
    event.preventDefault();
    TripPlans.setActiveSlug(slug);
    navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(slug));
    return;
  }
  if (target.closest("[data-dup]")) {
    event.preventDefault();
    void duplicateToMine(slug, variant === "public");
    return;
  }
  if (target.closest("[data-del]")) {
    event.preventDefault();
    const meta = TripPlans.get(slug);
    const name = meta && meta.title ? meta.title : "この計画";
    if (window.confirm("「" + name + "」を削除しますか？この操作は元に戻せません。")) {
      void TripPlans.remove(slug).then(
        () => render(),
        (error) => showToast("削除できませんでした: " + errorMessage(error), true),
      );
    }
    return;
  }
});

hub.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const authorLink = target.closest<HTMLElement>("[data-author-link]");
  if (!authorLink) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  openAuthorPage(authorLink);
});

filterEl.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | null;
  state.filter = (target && target.value) || "";
  hub.classList.toggle("has-search-filter", Boolean(state.filter.trim()));
  render();
});

destinationsEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-dest-filter]");
  if (!link) return;
  event.preventDefault();
  const value = link.dataset.destFilter || "";
  queueLocationTransition("forward");
  state.selectedLocation = value;
  state.selectedPlanSlug = "";
  render();
});

locationHeadEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest("[data-location-back]")) return;
  event.preventDefault();
  queueLocationTransition("back");
  state.selectedLocation = "";
  state.selectedPlanSlug = "";
  render();
});

locationPlansEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLElement>("[data-location-plan]");
  if (!link) return;
  event.preventDefault();
  queueLocationTransition("swap");
  state.selectedPlanSlug = link.dataset.locationPlan || "";
  render();
});

window.addEventListener("trip-backend-sync", () => {
  render();
});

window.addEventListener("trip-account-logout", () => {
  state.filter = "";
  state.selectedLocation = "";
  state.selectedPlanSlug = "";
  filterEl.value = "";
  hub.classList.remove("is-search-open", "has-search-filter");
  searchToggleEl.setAttribute("aria-expanded", "false");
  render();
});

window.addEventListener("resize", () => {
  window.clearTimeout(rankingResizeTimer);
  rankingResizeTimer = window.setTimeout(() => {
    if (rankingCardLimit() !== getLastRankingLimit()) render();
  }, 120);
});

registerServiceWorker();

// 共有ストア（MySQL）を読み終えてから描画する。
// 読む前に描くと計画0件に見え、書き込むと実在しない行を作ってしまう。
void db.load().then(() => handleJoinLink()).then((joined) => {
  if (!joined) render();
});

// 控え（キャッシュ）で先に描いているので、裏の取り直しで中身が変わったら描き直す。
db.onDbSync(render);
