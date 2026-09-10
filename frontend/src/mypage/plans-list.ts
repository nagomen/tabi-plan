import { icon } from "../shared/icons";
import { escapeHtml } from "../shared/dom";
import { planDashboardHref } from "../shared/plan-url";
import * as TripPlans from "../shared/plans-store";
import type { PlanMeta } from "../shared/plans-store";
import { getUser } from "../shared/user-store";
import { isMemberOf } from "../shared/membership";
import { bandColor } from "../shared/calendar";

export interface PlansListEls {
  planMount: HTMLElement;
  planCount: HTMLElement;
}

// ---- 計画リスト ---------------------------------------------------------

export function mountPlansList(els: PlansListEls): { renderPlans: () => void } {
  const { planMount, planCount } = els;

  function planRow(plan: PlanMeta, allSlugs: string[]): string {
    const meta = [plan.dates, plan.members].filter(Boolean).map(escapeHtml).join(" ・ ");
    const draft = !TripPlans.isPublished(plan);
    const href = draft
      ? `plan-editor.html?plan=${encodeURIComponent(plan.slug)}`
      : planDashboardHref(plan.slug);
    const dotColor = draft ? "#b87418" : bandColor(plan.slug, allSlugs);
    return (
      `<a class="mp-row${draft ? " is-draft" : ""}" href="${href}">` +
      `<span class="mp-dot" style="background:${dotColor}"></span>` +
      `<span class="mp-row-body">` +
      `<span class="mp-row-name">` +
      `<span>${escapeHtml(plan.title || "無題の旅行")}</span>` +
      (draft ? `<span class="mp-draft-badge">${icon("pencilSquare")}作成中</span>` : "") +
      `</span>` +
      (meta ? `<span class="mp-row-meta">${meta}</span>` : "") +
      (draft ? `<span class="mp-row-meta mp-row-meta-draft">保存すると公開計画として扱われます</span>` : "") +
      `</span>` +
      `<span class="mp-chev">${icon("chevronRight")}</span>` +
      `</a>`
    );
  }

  // マイページは「自分が参加している計画のみ」を表示する。
  function renderPlans(): void {
    const all = TripPlans.list();
    const allSlugs = all.map((p) => p.slug); // 色は全計画基準で安定させる
    const userName = getUser().name;
    const list = all.filter(isMemberOf);
    const draftCount = list.filter((p) => !TripPlans.isPublished(p)).length;
    planCount.textContent = list.length ? `${list.length}件${draftCount ? `・作成中${draftCount}件` : ""}` : "";

    if (list.length) {
      planMount.innerHTML = list.map((p) => planRow(p, allSlugs)).join("");
      return;
    }
    planMount.innerHTML = userName
      ? `<div class="mp-empty"><b>参加している計画はありません</b><span>計画のメンバーに「${escapeHtml(userName)}」を追加すると表示されます</span></div>`
      : `<div class="mp-empty"><b>名前を設定してください</b><span>上で名前を入力（またはログイン）すると、参加している計画が表示されます</span></div>`;
  }

  return { renderPlans };
}
