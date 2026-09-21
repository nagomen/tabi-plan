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
import { CONFIG, hooks, isReadOnly } from "./state";
import { flashButton, root } from "./dom";
import { isOpenEditingVisitor } from "./plan-access";
import { readProfile } from "./profile";

// ---- メンバー（参加者一覧・招待） ---------------------------------------

interface ItineraryTrackOption { key: string; label: string }

function itineraryTrackOptions(planId: string): ItineraryTrackOption[] {
  const activeIds = new Set(db.members()
    .filter((member) => member.plan_id === planId && member.status === "active")
    .map((member) => member.user_id));
  const groups = new Map<string, string[]>();
  for (const item of db.itinerary().filter((row) => row.plan_id === planId)) {
    const ids = [...new Set((item.member_ids || []).filter((id) => activeIds.has(id)))].sort();
    if (!ids.length || ids.length >= activeIds.size) continue;
    groups.set(ids.join(","), ids);
  }
  return [...groups.entries()].map(([key, ids], index) => {
    const names = ids.map((id) => db.nameOf(id)).filter(Boolean);
    const detail = names.length > 3 ? `${names.slice(0, 3).join("・")}ほか` : names.join("・");
    return { key, label: `${String.fromCharCode(65 + (index % 26))}班${detail ? `（${detail}）` : ""}` };
  });
}

function configureMemberForm(planId: string): void {
  const plan = db.planById(planId);
  const trackSelect = root.querySelector<HTMLSelectElement>("[data-invite-track]");
  if (trackSelect) {
    const previous = trackSelect.value;
    const options = itineraryTrackOptions(planId);
    trackSelect.innerHTML = `<option value="">全員の予定を基本にする</option>` + options.map((option) =>
      `<option value="${escapeHtml(option.key)}">${escapeHtml(option.label)}</option>`,
    ).join("");
    if (options.some((option) => option.key === previous)) trackSelect.value = previous;
  }
  for (const input of [
    root.querySelector<HTMLInputElement>("[data-invite-from]"),
    root.querySelector<HTMLInputElement>("[data-invite-to]"),
  ]) {
    if (!input) continue;
    if (plan?.start_date) input.min = plan.start_date;
    else input.removeAttribute("min");
    if (plan?.end_date) input.max = plan.end_date;
    else input.removeAttribute("max");
  }
}

function setMemberStatus(message: string, error = false): void {
  const status = root.querySelector<HTMLElement>("[data-members-status]");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}

/** 参加メンバー一覧を描画。招待は owner、脱退は owner 以外の正式メンバーに表示。 */
export function renderMembers(data: TripData): void {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const membersStr = (meta && meta.members) || (data.trip && data.trip.members) || "";
  // 公開共同編集者は正式メンバーではないため、本人設定した名前を候補として扱う。
  // （連携元のメンバー表には載らないため、ここで補って「参加している」状態に見せる）。
  const openEditingVisitor = isOpenEditingVisitor();
  const myName = getUser().name.trim() || (openEditingVisitor ? (readProfile()?.name || "").trim() : "");
  const ownerId = meta ? (db.planBySlug(meta.slug)?.owner_user_id || "") : "";
  const canRemoveMembers = Boolean(meta && !isReadOnly() && canManagePlan(meta));
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
            const owner = Boolean(id && id === ownerId);
            const row = id ? db.members().find((member) => member.plan_id === meta?.id && member.user_id === id) : undefined;
            const placeholder = Boolean(id && meta?.id && db.isPlaceholderMember(meta.id, id));
            const canInvite = Boolean(canRemoveMembers && id && !owner && !self && (placeholder || row?.access_status !== "active"));
            const profileContent =
              `<span class="tl-member-avatar">${escapeHtml(name.slice(0, 1) || "?")}</span>` +
              `<span class="tl-member-name">${escapeHtml(name)}</span>` +
              (owner
                ? `<span class="tl-member-self-badge">管理者</span>`
                : self
                  ? `<span class="tl-member-self-badge">自分</span>`
                  : placeholder
                    ? `<span class="tl-member-self-badge is-pending">招待待ち</span>`
                    : "") +
              (placeholder ? "" : `<span class="tl-member-go">${icon("chevronRight")}</span>`);
            // アイコン/名前をタップするとその人の旅行履歴ページへ。
            return (
              `<div class="tl-member-row${self ? " is-self" : ""}">` +
              (placeholder
                ? `<div class="tl-member-profile">${profileContent}</div>`
                : `<a class="tl-member-profile" href="person.html?name=${encodeURIComponent(name)}${id ? `&user=${encodeURIComponent(id)}` : ""}" title="${escapeHtml(name)}さんの旅行履歴を見る">${profileContent}</a>`) +
              (canInvite
                ? `<button class="tl-member-invite" type="button" data-invite-member="${escapeHtml(id)}" data-invite-member-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)}さんへ招待リンクを送る">${icon("paperAirplane")}<span>招待</span></button>`
                : "") +
              (canRemoveMembers && id && !owner && !self
                ? `<button class="tl-member-remove" type="button" data-remove-member="${escapeHtml(id)}" data-remove-member-name="${escapeHtml(name)}" aria-label="${escapeHtml(name)}さんを旅行から削除">${icon("trash")}<span>削除</span></button>`
                : "") +
              `</div>`
            );
          })
          .join("")
      : `<div class="tl-members-empty">まだメンバーがいません。下から招待できます。</div>`;
  }

  const inviteEl = root.querySelector<HTMLElement>("[data-members-invite]");
  if (inviteEl) inviteEl.hidden = isReadOnly() || CONFIG.mode !== "local" || !meta || !canManagePlan(meta);
  if (meta?.id && canRemoveMembers) configureMemberForm(meta.id);

  // 脱退は「名前を設定した参加メンバー」だけ（＝自分が一覧にいる）。
  const leaveEl = root.querySelector<HTMLElement>("[data-members-leave]");
  if (leaveEl) leaveEl.hidden = isReadOnly() || !meta || !isMemberOf(meta) || canManagePlan(meta);
}

/** ownerが参加者を名簿・アクセス権・個人行程から即時に外す。 */
export async function removeTripMember(userId: string, name: string, button?: HTMLButtonElement): Promise<void> {
  if (isReadOnly()) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta?.id || !userId || !canManagePlan(meta)) return;
  const confirmed = window.confirm(
    `${name}さんをこの旅行から削除しますか？\n\n` +
    "この計画へアクセスできなくなります。その人だけの予定は削除され、費用・精算の履歴は残ります。",
  );
  if (!confirmed) return;
  if (button) button.disabled = true;
  try {
    const result = await db.removePlanMember(meta.id, userId);
    hooks.renderData(TripPlans.toDashboardData(TripPlans.getData(CONFIG.tripSlug)), CONFIG.mode);
    const suffix = result.removedItineraryItems
      ? `（その人だけの予定 ${result.removedItineraryItems}件も削除）`
      : "";
    setMemberStatus(`${name}さんを旅行から削除しました${suffix}`);
  } catch (error) {
    if (button) {
      button.disabled = false;
      flashButton(button, errorMessage(error) || "削除できませんでした");
    }
  }
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

type ShareResult = "shared" | "copied" | "cancelled" | "failed";

async function createAndShareMemberInvite(
  userId: string,
  name: string,
  role: "editor" | "viewer",
  btn?: HTMLButtonElement,
): Promise<ShareResult> {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const planId = meta?.id || "";
  if (!meta || !planId || !canManagePlan(meta)) {
    if (btn) flashButton(btn, "所有者のみ招待できます");
    return "failed";
  }
  let createdInviteId = "";
  const revokeCreatedInvite = async (successLabel: string): Promise<boolean> => {
    if (!createdInviteId) return true;
    try {
      await db.revokeInvite(planId, createdInviteId);
      if (btn) flashButton(btn, successLabel);
      return true;
    } catch (error) {
      if (btn) flashButton(btn, errorMessage(error) || "招待の取消に失敗しました");
      return false;
    }
  };
  try {
    const invite = await db.createInvite(planId, { invited_name: name, invited_user_id: userId, role });
    createdInviteId = invite.id;
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
      invitedName: name,
      role,
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
        await revokeCreatedInvite("招待は未送信です");
        return "cancelled";
      }
      if (btn) flashButton(btn, "共有しました");
      return "shared";
    }
    try {
      await navigator.clipboard.writeText(link);
      if (btn) flashButton(btn, "リンクをコピーしました");
    } catch {
      const copied = window.prompt("招待リンクをコピーしてください", link);
      if (copied === null) {
        await revokeCreatedInvite("招待は未送信です");
        return "cancelled";
      }
    }
    return "copied";
  } catch (error) {
    if (!(await revokeCreatedInvite("招待は未送信です"))) return "failed";
    // 権限なし・回数制限・期限切れを見分けられるよう、サーバーの説明をそのまま出す
    if (btn) flashButton(btn, errorMessage(error) || "作成できませんでした");
    return "failed";
  }
}

/** 名前・参加期間・旅程分類を登録してから、本人専用の招待リンクを共有する。 */
export async function shareTripInvite(): Promise<void> {
  if (isReadOnly()) return;
  const meta = TripPlans.get(CONFIG.tripSlug);
  const btn = root.querySelector<HTMLButtonElement>("[data-invite-share]");
  if (!meta?.id || !canManagePlan(meta)) {
    if (btn) flashButton(btn, "所有者のみ追加できます");
    return;
  }
  const nameInput = root.querySelector<HTMLInputElement>("[data-invite-name]");
  const name = (nameInput?.value || "").trim();
  if (!name) {
    nameInput?.focus();
    if (btn) flashButton(btn, "参加者名を入力してください");
    return;
  }
  if (meta.memberIds?.some((id) => db.nameOf(id).trim() === name)) {
    if (btn) flashButton(btn, "同じ名前のメンバーがいます");
    return;
  }
  const roleInput = root.querySelector<HTMLSelectElement>("[data-invite-role]");
  const role = roleInput?.value === "viewer" ? "viewer" : "editor";
  const fromInput = root.querySelector<HTMLInputElement>("[data-invite-from]");
  const toInput = root.querySelector<HTMLInputElement>("[data-invite-to]");
  const fromDate = fromInput?.value || "";
  const toDate = toInput?.value || "";
  if (!fromInput?.checkValidity() || !toInput?.checkValidity() || (fromDate && toDate && fromDate > toDate)) {
    if (btn) flashButton(btn, "参加期間を確認してください");
    return;
  }
  const trackKey = root.querySelector<HTMLSelectElement>("[data-invite-track]")?.value || "";
  const trackMemberIds = trackKey.split(",").map((id) => id.trim()).filter(Boolean);
  if (btn) btn.disabled = true;
  try {
    const created = await db.createPlaceholderMember(meta.id, name, role, { fromDate, toDate, trackMemberIds });
    hooks.renderData(TripPlans.toDashboardData(TripPlans.getData(CONFIG.tripSlug)), CONFIG.mode);
    if (nameInput) nameInput.value = "";
    if (fromInput) fromInput.value = "";
    if (toInput) toInput.value = "";
    const result = await createAndShareMemberInvite(created.user.id, name, role, btn || undefined);
    const assignment = created.assignedItineraryItems
      ? `、${created.assignedItineraryItems}件の予定へ分類済み`
      : "";
    setMemberStatus(
      result === "shared"
        ? `${name}さんを追加して招待を共有しました${assignment}`
        : result === "copied"
          ? `${name}さんを追加し、招待リンクをコピーしました${assignment}`
          : `${name}さんを追加しました。招待は一覧から再送できます${assignment}`,
      result === "failed",
    );
  } catch (error) {
    if (btn) flashButton(btn, errorMessage(error) || "メンバーを追加できませんでした");
    setMemberStatus(errorMessage(error) || "メンバーを追加できませんでした", true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 未登録またはアクセス未受諾のメンバーへ、本人専用リンクを再発行する。 */
export async function shareExistingMemberInvite(
  userId: string,
  name: string,
  button?: HTMLButtonElement,
): Promise<void> {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta?.id || !userId || !canManagePlan(meta)) return;
  const member = db.members().find((row) => row.plan_id === meta.id && row.user_id === userId && row.status === "active");
  if (!member || member.role === "owner") return;
  if (button) button.disabled = true;
  const result = await createAndShareMemberInvite(
    userId,
    name,
    member.role === "viewer" ? "viewer" : "editor",
    button,
  );
  if (button) button.disabled = false;
  setMemberStatus(
    result === "shared"
      ? `${name}さんへ招待を共有しました`
      : result === "copied"
        ? `${name}さんの招待リンクをコピーしました`
        : `${name}さんへの招待は未送信です`,
    result === "failed",
  );
}
