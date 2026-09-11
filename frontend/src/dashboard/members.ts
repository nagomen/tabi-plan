import { navigateWithPageTransition } from "../shared/page-transition";
import { icon } from "../shared/icons";
import * as TripPlans from "../shared/plans-store";
import { getUser } from "../shared/user-store";
import { canManagePlan, isMemberOf } from "../shared/membership";
import { currentUserId } from "../shared/identity";
import * as db from "../shared/db";
import { splitNames } from "../shared/friend-store";
import { buildInviteLink } from "../shared/invite";
import { escapeHtml, errorMessage } from "../shared/dom";
import type { TripData } from "../shared/types";
import { CONFIG, isReadOnly } from "./state";
import { flashButton, root } from "./dom";
import { isOpenEditingVisitor } from "./plan-access";
import { readProfile } from "./profile";

// ---- メンバー（参加者一覧・招待） ---------------------------------------

/** 参加メンバー一覧を描画。招待は owner、脱退は owner 以外の正式メンバーに表示。 */
export function renderMembers(data: TripData): void {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const membersStr = (meta && meta.members) || (data.trip && data.trip.members) || "";
  // 公開共同編集者は正式メンバーではないため、本人設定した名前を候補として扱う。
  // （連携元のメンバー表には載らないため、ここで補って「参加している」状態に見せる）。
  const openEditingVisitor = isOpenEditingVisitor();
  const myName = getUser().name.trim() || (openEditingVisitor ? (readProfile()?.name || "").trim() : "");
  const people = meta?.memberIds?.length
    ? meta.memberIds.map((id) => ({ id, name: db.nameOf(id) })).filter((person) => person.name)
    : splitNames(membersStr).map((name) => ({ id: "", name }));
  if (openEditingVisitor && myName && !people.some((person) => person.name === myName)) {
    people.unshift({ id: currentUserId(), name: myName });
  }

  const countEl = root.querySelector<HTMLElement>("[data-members-count]");
  if (countEl) countEl.textContent = people.length ? `${people.length}人` : "";

  const listEl = root.querySelector<HTMLElement>("[data-members-list]");
  if (listEl) {
    listEl.innerHTML = people.length
      ? people
          .map(({ id, name }) => {
            const self = id ? id === currentUserId() : Boolean(myName) && name === myName;
            // アイコン/名前をタップするとその人の旅行履歴ページへ。
            return (
              `<a class="tl-member-row${self ? " is-self" : ""}" href="person.html?name=${encodeURIComponent(name)}${id ? `&user=${encodeURIComponent(id)}` : ""}" title="${escapeHtml(name)}さんの旅行履歴を見る">` +
              `<span class="tl-member-avatar">${escapeHtml(name.slice(0, 1) || "?")}</span>` +
              `<span class="tl-member-name">${escapeHtml(name)}</span>` +
              (self ? `<span class="tl-member-self-badge">自分</span>` : "") +
              `<span class="tl-member-go">${icon("chevronRight")}</span>` +
              "</a>"
            );
          })
          .join("")
      : `<div class="tl-members-empty">まだメンバーがいません。下から招待できます。</div>`;
  }

  const inviteEl = root.querySelector<HTMLElement>("[data-members-invite]");
  if (inviteEl) inviteEl.hidden = isReadOnly() || CONFIG.mode !== "local" || !meta || !canManagePlan(meta);

  // 脱退は「名前を設定した参加メンバー」だけ（＝自分が一覧にいる）。
  const leaveEl = root.querySelector<HTMLElement>("[data-members-leave]");
  if (leaveEl) leaveEl.hidden = isReadOnly() || !meta || !isMemberOf(meta) || canManagePlan(meta);
}

/** 自分をこの旅行のメンバーから外して一覧へ戻る（脱退）。 */
export async function leaveTrip(): Promise<void> {
  if (isReadOnly()) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta || !meta.id || !isMemberOf(meta) || canManagePlan(meta)) return;
  try {
    await db.leavePlan(meta.id);
    navigateWithPageTransition("plans.html");
  } catch (error) {
    const leaveButton = root.querySelector<HTMLButtonElement>("[data-leave-trip]");
    if (leaveButton) flashButton(leaveButton, errorMessage(error) || "脱退できませんでした");
  }
}

/** 招待リンクを作成して共有／コピーする（ローカル計画のみ）。 */
export async function shareTripInvite(): Promise<void> {
  if (isReadOnly()) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  const planData = TripPlans.getData(CONFIG.tripSlug);
  const btn = root.querySelector<HTMLButtonElement>("[data-invite-share]");
  if (!meta || !planData) {
    if (btn) flashButton(btn, "招待に未対応");
    return;
  }
  if (!canManagePlan(meta)) {
    if (btn) flashButton(btn, "所有者のみ招待できます");
    return;
  }
  const nameInput = root.querySelector<HTMLInputElement>("[data-invite-name]");
  const name = (nameInput?.value || "").trim();
  try {
    const planId = TripPlans.planIdOf(meta.slug);
    if (!planId) throw new Error("計画IDが見つかりません");
    const invite = await db.createInvite(planId, { invited_name: name || undefined, role: "editor" });
    const link = await buildInviteLink({
      v: 1,
      meta: {
        slug: meta.slug,
        title: meta.title,
        dates: meta.dates,
        members: meta.members,
        route: meta.route,
        updatedAt: meta.updatedAt,
      },
      token: invite.token,
      invitedName: name || undefined,
      role: "editor",
    });
    const shareData = {
      title: meta.title || "旅行計画",
      text: `「${meta.title || "旅行"}」に${name ? `${name}さんを` : ""}招待します`,
      url: link,
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        /* 共有キャンセル */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      if (btn) flashButton(btn, "リンクをコピーしました");
    } catch {
      window.prompt("招待リンクをコピーしてください", link);
    }
    if (nameInput) nameInput.value = "";
  } catch (error) {
    // 権限なし・回数制限・期限切れを見分けられるよう、サーバーの説明をそのまま出す
    if (btn) flashButton(btn, errorMessage(error) || "作成できませんでした");
  }
}
