import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { navigateWithPageTransition } from "../shared/page-transition";
import { currentUserId } from "../shared/identity";
import { hub } from "./dom";
import { showToast } from "./toast";
import { render } from "./render";

export function closeMenus(except?: Element | null): void {
  hub.querySelectorAll<HTMLElement>("[data-menu-panel]").forEach((panel) => {
    if (panel === except) return;
    panel.hidden = true;
    const btn = panel.parentElement?.querySelector<HTMLButtonElement>("[data-menu]");
    if (btn) btn.setAttribute("aria-expanded", "false");
  });
}

/**
 * 計画を自分のローカル計画へ複製する。
 * 公開計画からの複製時は、所有＝メンバーのため自分の名前をメンバーに加え、
 * 「自分の計画」セクションに出るようにする。
 */
export async function duplicateToMine(slug: string, fromPublic: boolean): Promise<void> {
  if (!currentUserId()) {
    navigateWithPageTransition("login.html?returnTo=" + encodeURIComponent("plans.html"));
    return;
  }
  // 既にコピーを持っているなら、作り直さずそれを開く。
  const already = TripPlans.existingCopyOf(slug);
  if (already) {
    showToast("すでにコピーがあります。そのコピーを開きます");
    navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(already.slug));
    return;
  }
  let copy: PlanMeta | null = null;
  try {
    copy = await TripPlans.duplicateAndSave(slug);
  } catch (error) {
    render();
    showToast("コピーを保存できませんでした");
    console.error("[plans] duplicate", error);
    return;
  }
  if (!copy) {
    render();
    return;
  }
  // 参加者は duplicate() が複製者ひとりに揃えるので、ここでは触らない。
  render();
  showToast(fromPublic ? "自分の計画に複製しました。編集画面を開きます" : "計画を複製しました。編集画面を開きます");
  navigateWithPageTransition("plan-editor.html?plan=" + encodeURIComponent(copy.slug));
}

export function openAuthorPage(link: HTMLElement): void {
  const href = link.dataset.authorLink;
  if (!href) return;
  navigateWithPageTransition(href);
}
