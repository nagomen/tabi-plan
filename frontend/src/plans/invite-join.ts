import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import { navigateWithPageTransition } from "../shared/page-transition";
import { escapeHtml, errorMessage } from "../shared/dom";
import { planDashboardHref } from "../shared/plan-url";
import { rememberInviteReturn } from "../shared/invite-resume";
import { decodeInvite } from "../shared/invite";
import { isIdentified } from "../shared/identity";
import { showToast } from "./toast";

function chooseInviteMember(inspection: db.InviteInspection): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "pub-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "join-member-title");
    modal.innerHTML = `
      <div class="pub-box">
        <h2 id="join-member-title">旅行メンバーの中で、あなたは誰ですか？</h2>
        <div class="pub-body">
          <p>「${escapeHtml(inspection.planTitle || "旅行計画")}」に登録されている名前を選んでください。参加後、その名前はあなたのアカウント名に置き換わります。</p>
          <div class="join-member-options">
            ${inspection.memberOptions.map((member) => `
              <label class="join-member-option">
                <input type="radio" name="join-member" value="${escapeHtml(member.userId)}">
                <span>${escapeHtml(member.displayName)}</span>
              </label>
            `).join("")}
          </div>
          <div class="pub-error" data-join-error></div>
          <div class="pub-actions">
            <button type="button" class="secondary" data-join-cancel>キャンセル</button>
            <button type="button" data-join-next disabled>次へ</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const next = modal.querySelector<HTMLButtonElement>("[data-join-next]");
    const finish = (value: string | null): void => {
      modal.remove();
      resolve(value);
    };
    modal.addEventListener("change", () => {
      if (next) next.disabled = !modal.querySelector<HTMLInputElement>('input[name="join-member"]:checked');
    });
    modal.querySelector("[data-join-cancel]")?.addEventListener("click", () => finish(null));
    next?.addEventListener("click", () => {
      const selected = modal.querySelector<HTMLInputElement>('input[name="join-member"]:checked')?.value || "";
      if (selected) finish(selected);
    });
    modal.querySelector<HTMLInputElement>('input[name="join-member"]')?.focus();
  });
}

// 招待リンク（plans.html#join=<token>）を開いたら、計画を取り込んでダッシュボードへ。
// 同じ計画（slug 一致）が既にあれば重複作成せず、本文を最新に更新しつつ候補の票はマージする。
export async function handleJoinLink(): Promise<boolean> {
  const m = /(?:^|[#&])join=([^&]+)/.exec(location.hash || "");
  if (!m) return false;
  const payload = await decodeInvite(m[1]);
  if (!payload) {
    history.replaceState(null, "", location.pathname + location.search);
    showToast("招待リンクを読み込めませんでした。", true);
    return false;
  }
  const slug = TripPlans.safeSlug(payload.meta.slug || payload.meta.title || "trip");
  if (payload.token) {
    let selectedMemberId = /(?:^|[&#])member=([^&]+)/.exec(location.hash || "")?.[1] || "";
    try { selectedMemberId = decodeURIComponent(selectedMemberId); } catch { selectedMemberId = ""; }
    let inspection: db.InviteInspection;
    try {
      inspection = await db.inspectInvite(payload.token);
    } catch (error) {
      history.replaceState(null, "", location.pathname + location.search);
      showToast(errorMessage(error) || "この招待リンクは利用できません。", true);
      return true;
    }
    const validSelectedMember = inspection.memberOptions.some((member) => member.userId === selectedMemberId);
    if (inspection.requiresMemberSelection && !validSelectedMember) {
      selectedMemberId = await chooseInviteMember(inspection) || "";
      if (!selectedMemberId) {
        history.replaceState(null, "", location.pathname + location.search);
        return false;
      }
      history.replaceState(
        null,
        "",
        `${location.pathname}${location.search}#join=${encodeURIComponent(m[1])}&member=${encodeURIComponent(selectedMemberId)}`,
      );
    }
    if (!isIdentified()) {
      const memberPart = selectedMemberId ? `&member=${encodeURIComponent(selectedMemberId)}` : "";
      const returnTo = `${location.pathname}${location.search}#join=${encodeURIComponent(m[1])}${memberPart}`;
      if (!rememberInviteReturn(returnTo)) throw new Error("招待情報をこの端末に保存できませんでした");
      navigateWithPageTransition("login.html?resumeInvite=1&returnTo=plans.html", { replace: true });
      return true;
    }
    try {
      const accepted = await db.acceptInvite(payload.token, selectedMemberId);
      const nextSlug = accepted.planSlug || slug;
      TripPlans.setActiveSlug(nextSlug);
      history.replaceState(null, "", location.pathname + location.search);
      navigateWithPageTransition(planDashboardHref(nextSlug), { replace: true });
    } catch (error) {
      history.replaceState(null, "", location.pathname + location.search);
      showToast(errorMessage(error) || "招待リンクを受け取れませんでした。ログインしてからもう一度開いてください。", true);
    }
    return true;
  }
  history.replaceState(null, "", location.pathname + location.search);
  showToast("この招待リンクは旧形式です。計画の所有者に新しいリンクの発行を依頼してください。", true);
  return true;
}
