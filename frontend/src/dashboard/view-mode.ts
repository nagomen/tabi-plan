import { getMobileView, hooks, leafletState, setMobileView, state } from "./state";
import { qsa, root } from "./dom";
import { refreshMapLayout } from "./map";

// ---- 表示モード（モバイル / セクション） --------------------------------

export function applyMobileView(view?: string): void {
  const mobileView = view || getMobileView() || "home";
  setMobileView(mobileView);
  if (mobileView === "map") leafletState.followActive = true;
  root.dataset.sectionView = mobileView;
  root.dataset.mobileView = mobileView;
  root.classList.add("is-mobile-responsive");
  syncStickyOffsets();
  qsa<HTMLElement>("[data-mobile-view]").forEach((node) => {
    const views = String(node.dataset.mobileView || "").split(/\s+/);
    node.classList.toggle("is-mobile-active", views.includes(mobileView));
  });
  qsa<HTMLElement>("[data-section-nav]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.sectionNav === mobileView));
  });
  qsa<HTMLElement>("[data-mobile-nav]").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.mobileNav === mobileView));
  });
  if (mobileView === "home" || mobileView === "map") {
    setTimeout(() => {
      refreshMapLayout();
      if (getMobileView() === "map" && state.days.length && !leafletState.map) hooks.renderActive();
    }, 80);
  }
}

export function syncStickyOffsets(): void {
  const head = root.querySelector<HTMLElement>(".ah");
  if (!head) return;
  root.style.setProperty("--tl-head-height", `${Math.ceil(head.getBoundingClientRect().height)}px`);
}

export function syncMobileNavLayout(): void {
  const nav = root.querySelector<HTMLElement>(".tl-mobile-nav");
  if (!nav) return;
  const visibleCount = qsa<HTMLElement>("[data-mobile-nav]").filter((button) => !button.hidden).length;
  nav.style.setProperty("--tl-mobile-nav-count", String(Math.max(1, visibleCount)));
}
