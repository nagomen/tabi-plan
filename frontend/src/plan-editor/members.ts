import * as db from "../shared/db";
import * as TripPlans from "../shared/plans-store";
import { escapeHtml, errorMessage } from "../shared/dom";
import { parseISO, mdLabel } from "../shared/date";
import { icon } from "../shared/icons";
import { splitNames } from "../shared/friend-store";
import { buildInviteLink } from "../shared/invite";
import { currentAccount } from "../shared/account-store";
import { listFriends } from "../shared/friendship-store";
import { canManagePlan } from "../shared/membership";
import { state, model, datesString } from "./editor-state";
import {
  root, membersMount, memberField, memberSelect, memberAddBtn, memberNameInput, memberHint, activeInvitesMount, toast,
} from "./editor-dom";
import { markDirty, persist } from "./persist";
import { buildData } from "./plan-data";

// ---- メンバー（チップ／友達候補／招待リンク） --------------------------

function hasMemberAccount(): boolean {
  return Boolean(currentAccount());
}

function memberArray(): string[] { return splitNames(model.members); }
function syncMemberNames(): void {
  model.members = [
    ...model.memberIds.map((id) => db.nameOf(id)).filter(Boolean),
    ...model.pendingMembers.map((member) => member.name),
  ].join("、");
}
function setMembers(ids: string[]): void {
  model.memberIds = [...new Set(ids.filter(Boolean))];
  syncMemberNames();
  markDirty();
  updateMemberVisibility();
  renderMembers();
  renderMemberSelect();
}
function addMember(userId: string): void {
  if (!userId) return;
  setMembers([...model.memberIds, userId]);
}
function removeMember(userId: string): void {
  setMembers(model.memberIds.filter((id) => id !== userId));
}
function addPendingMember(name: string): void {
  const displayName = name.trim().slice(0, 64);
  if (!displayName) return;
  model.pendingMembers.push({ key: `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: displayName });
  syncMemberNames();
  markDirty();
  renderMembers();
}
function removePendingMember(key: string): void {
  model.pendingMembers = model.pendingMembers.filter((member) => member.key !== key);
  syncMemberNames();
  markDirty();
  renderMembers();
}

export async function persistPendingMembers(): Promise<void> {
  if (!model.pendingMembers.length || !state.slug) return;
  const planId = TripPlans.planIdOf(state.slug);
  if (!planId) throw new Error("旅行を保存してから未登録メンバーを追加してください");
  model.memberIds = [...new Set([
    ...model.memberIds,
    ...db.members()
      .filter((member) => member.plan_id === planId && member.status === "active")
      .map((member) => member.user_id),
  ])];
  const pending = [...model.pendingMembers];
  try {
    for (const entry of pending) {
      const created = await db.createPlaceholderMember(planId, entry.name);
      model.memberIds.push(created.user.id);
      model.pendingMembers = model.pendingMembers.filter((member) => member.key !== entry.key);
    }
  } finally {
    // 途中の1件で失敗しても、既に作成済みの人を「保存前」と表示し続けない。
    model.memberIds = [...new Set(model.memberIds)];
    syncMemberNames();
    renderMembers();
    renderMemberSelect();
  }
}

export function renderMembers(): void {
  const account = currentAccount();
  const me = account?.name || "";
  const arr = memberArray();
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const stored = meta ? db.planBySlug(meta.slug) : null;
  const ownerId = stored?.owner_user_id || account?.id || "";
  const memberAccounts = model.memberIds.map((id) => ({ id, name: db.nameOf(id) })).filter((member) => member.name);
  const savedMembers = memberAccounts.length
    ? memberAccounts.map((member) => ({ ...member, pendingKey: "" }))
    : model.pendingMembers.length
      ? []
      : arr.map((name) => ({ id: listFriends().find((friend) => friend.name === name)?.id || "", name, pendingKey: "" }));
  const displayMembers = savedMembers.concat(
    model.pendingMembers.map((member) => ({ id: "", name: member.name, pendingKey: member.key })),
  );
  const planId = stored?.id || "";
  const memberChips = displayMembers
    .map((member) => {
      const self = account?.id ? member.id === account.id : Boolean(me) && member.name === me;
      const placeholder = Boolean(member.id && planId && db.isPlaceholderMember(planId, member.id));
      const claimedPlaceholder = member.id && planId ? db.claimedPlaceholderFor(planId, member.id) : undefined;
      return (
        `<span class="pe-chip-m${self ? " is-self" : ""}">` +
        `<span>${escapeHtml(member.name)}</span>` +
        (self ? `<span class="pe-chip-self">自分</span>` : "") +
        (member.id === ownerId ? `<span class="pe-chip-self">Owner</span>` : "") +
        (member.pendingKey ? `<span class="pe-chip-pending">保存前</span>` : "") +
        (placeholder ? `<span class="pe-chip-pending">未登録</span>` : "") +
        (claimedPlaceholder ? `<span class="pe-chip-pending">本人紐付済み</span>` : "") +
        (meta && canManagePlan(meta) && member.id && !placeholder && !self && member.id !== ownerId
          ? `<button class="pe-chip-ic" type="button" data-transfer-owner="${escapeHtml(member.id)}" data-transfer-name="${escapeHtml(member.name)}" title="所有権を移譲" aria-label="${escapeHtml(member.name)}へ所有権を移譲">${icon("arrowsRightLeft")}</button>`
          : "") +
        (!account || self || member.pendingKey
          ? ""
          : `<button class="pe-chip-ic invite" type="button" data-invite="${escapeHtml(member.name)}" data-invite-user="${escapeHtml(member.id)}" title="招待リンクを送る" aria-label="${escapeHtml(member.name)}を招待">${icon("paperAirplane")}</button>`) +
        (member.pendingKey
          ? `<button class="pe-chip-ic del" type="button" data-rm-pending="${escapeHtml(member.pendingKey)}" title="削除" aria-label="${escapeHtml(member.name)}を削除">${icon("xMark")}</button>`
          : member.id && member.id !== ownerId
          ? `<button class="pe-chip-ic del" type="button" data-rm="${escapeHtml(member.id)}" title="削除" aria-label="${escapeHtml(member.name)}を削除">${icon("xMark")}</button>`
          : "") +
        (claimedPlaceholder && meta && canManagePlan(meta) && member.id !== ownerId
          ? `<button class="pe-chip-ic del" type="button" data-unclaim="${escapeHtml(claimedPlaceholder.user_id)}" title="本人紐付けを取り消す" aria-label="${escapeHtml(member.name)}の本人紐付けを取り消す">${icon("arrowPath")}</button>`
          : "") +
        `</span>`
      );
    })
    .join("");
  membersMount.innerHTML = memberChips + memberPeriodsHtml();
  void renderActiveInvites();
}

let inviteListLoading = false;
async function renderActiveInvites(): Promise<void> {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) {
    activeInvitesMount.innerHTML = "";
    return;
  }
  if (inviteListLoading) return;
  inviteListLoading = true;
  try {
    const pending = (await db.listInvites(meta.id)).filter((invite) => invite.status === "pending");
    activeInvitesMount.innerHTML = pending.length
      ? `<p class="pe-member-hint">有効な招待 ${pending.length}件</p>` + pending.map((invite) =>
        `<span class="pe-chip-m"><span>${escapeHtml(invite.invited_name || "共通招待")}</span>` +
        `<span class="pe-chip-pending">${invite.role === "viewer" ? "閲覧" : "編集"}</span>` +
        `<button class="pe-chip-ic del" type="button" data-revoke-invite="${escapeHtml(invite.id)}" aria-label="招待を取り消す">${icon("xMark")}</button></span>`,
      ).join("")
      : "";
  } catch {
    activeInvitesMount.innerHTML = `<p class="pe-member-hint">有効な招待を取得できませんでした</p>`;
  } finally {
    inviteListLoading = false;
  }
}

export function onActiveInvitesClick(event: MouseEvent): void {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-revoke-invite]") : null;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!button || !meta?.id) return;
  button.setAttribute("disabled", "true");
  void db.revokeInvite(meta.id, button.dataset.revokeInvite || "")
    .then(() => renderActiveInvites())
    .catch((error) => { toast(errorMessage(error) || "招待を取り消せませんでした"); button.removeAttribute("disabled"); });
}

/**
 * メンバーごとの参加期間。デフォルトは全員が全日程参加（内部では null 端＝無制限）。
 * 全員が全日程のうちは1行のサマリに畳み、「途中合流/離脱を設定」で展開する。
 * 保存済み計画で、旅行期間が決まっていて、管理者のときだけ出す。
 */
let memberPeriodsOpen = false;

function memberPeriodLabel(dates: { from: string | null; to: string | null }): string {
  if (!dates.from && !dates.to) return "全日程";
  if (dates.from && dates.to) return `${mdLabel(dates.from)}〜${mdLabel(dates.to)}`;
  return dates.from ? `${mdLabel(dates.from)} 合流` : `${mdLabel(dates.to || "")} 離脱`;
}

/** 旅行期間の中でどこに在籍しているかを示すミニバー。期間がパースできないときは出さない。 */
function memberPeriodBar(dates: { from: string | null; to: string | null }, start: string, end: string): string {
  const startD = parseISO(start);
  const endD = parseISO(end);
  if (!startD || !endD) return "";
  const total = Math.round((endD.getTime() - startD.getTime()) / 86400000) + 1;
  if (total <= 0) return "";
  const dayIndex = (iso: string | null, fallback: number): number => {
    const d = iso ? parseISO(iso) : null;
    if (!d) return fallback;
    return Math.min(Math.max(Math.round((d.getTime() - startD.getTime()) / 86400000), 0), total - 1);
  };
  let fromIdx = dayIndex(dates.from, 0);
  let toIdx = dayIndex(dates.to, total - 1);
  if (toIdx < fromIdx) { fromIdx = 0; toIdx = total - 1; }
  const left = (fromIdx / total) * 100;
  const width = ((toIdx - fromIdx + 1) / total) * 100;
  return `<span class="pe-mperiod-bar" aria-hidden="true"><span style="left:${left}%;width:${width}%"></span></span>`;
}

function memberPeriodsHtml(): string {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) return "";
  if (!model.startDate || !model.endDate) return "";
  const ids = model.memberIds.filter((id) => id && db.nameOf(id));
  if (!ids.length) return "";
  const start = model.startDate;
  const end = model.endDate;
  const isFull = (id: string): boolean => {
    const dates = model.memberDates[id];
    return !dates || (!dates.from && !dates.to);
  };
  const allFull = ids.every(isFull);
  if (allFull && !memberPeriodsOpen) {
    return (
      `<div class="pe-mperiods is-collapsed">` +
      `<p class="pe-mperiods-head">${icon("calendarDays")}参加期間</p>` +
      `<div class="pe-mperiods-summary">` +
      `<span>全員が全日程（${mdLabel(start)}〜${mdLabel(end)}）に参加</span>` +
      `<button class="pe-mperiods-toggle" type="button" data-mperiods-toggle>途中合流/離脱を設定</button>` +
      `</div>` +
      `</div>`
    );
  }
  const row = (id: string): string => {
    const dates = model.memberDates[id] || { from: null, to: null };
    const full = isFull(id);
    return (
      `<div class="pe-mperiod${full ? "" : " is-partial"}">` +
      `<span class="pe-mperiod-name">${escapeHtml(db.nameOf(id))}</span>` +
      memberPeriodBar(dates, start, end) +
      `<span class="pe-mperiod-badge${full ? " is-full" : ""}">${escapeHtml(memberPeriodLabel(dates))}</span>` +
      `<span class="pe-mperiod-fields">` +
      `<label class="pe-mperiod-field">合流<input type="date" data-member-from="${escapeHtml(id)}" value="${dates.from || start}" min="${start}" max="${end}"></label>` +
      `<label class="pe-mperiod-field">離脱<input type="date" data-member-to="${escapeHtml(id)}" value="${dates.to || end}" min="${start}" max="${end}"></label>` +
      (full
        ? ""
        : `<button class="pe-mperiod-reset" type="button" data-member-reset="${escapeHtml(id)}" title="全日程参加に戻す">全日程に戻す</button>`) +
      `</span>` +
      `</div>`
    );
  };
  return (
    `<div class="pe-mperiods">` +
    `<p class="pe-mperiods-head">${icon("calendarDays")}参加期間` +
    (allFull ? `<button class="pe-mperiods-toggle" type="button" data-mperiods-toggle>閉じる</button>` : "") +
    `</p>` +
    `<p class="pe-mperiods-desc">初期設定は全員が全日程参加です。途中合流/離脱する人だけ日付を変えてください。</p>` +
    ids.map(row).join("") +
    `<p class="pe-mperiods-note">その日の費用は「全員で等分」でも、在籍していた人だけで割ります。</p>` +
    `</div>`
  );
}

/** 現在の memberIds・役割・参加期間から、メンバー一覧をまるごと保存する。 */
function persistMemberDates(): void {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) return;
  const ownerId = db.planBySlug(meta.slug)?.owner_user_id || currentAccount()?.id || "";
  const checkpoint = db.mutationCheckpoint();
  db.replaceMembers(meta.id, model.memberIds.filter(Boolean).map((id) => {
    const current = db.members().find((member) => member.plan_id === meta.id && member.user_id === id);
    const dates = model.memberDates[id] || { from: null, to: null };
    return {
      user_id: id,
      role: id === ownerId ? "owner" : current?.role === "viewer" ? "viewer" : "editor",
      from_date: dates.from,
      to_date: dates.to,
    };
  }));
  // 投げっぱなしにせず、失敗したら画面へ返す（成功表示のまま消えるのを防ぐ）
  void db.flushMutations(checkpoint).catch((error) => {
    toast(errorMessage(error) || "参加期間を保存できませんでした");
  });
}

function memberCandidates(): { id: string; name: string }[] {
  const account = currentAccount();
  if (!account) return [];
  const excluded = new Set([account.id, ...model.memberIds]);
  return listFriends()
    .filter((friend) => friend.id && !excluded.has(friend.id))
    .map((friend) => ({ id: friend.id, name: (friend.name || friend.email).trim() }))
    .filter((friend) => friend.name)
    .sort((a, b) => a.name.localeCompare(b.name, "ja"))
    .slice(0, 12);
}

export function renderMemberSelect(): void {
  const candidates = memberCandidates();
  memberSelect.innerHTML =
    `<option value="">友達を選択</option>` +
    (candidates.length
      ? candidates.map((friend) => `<option value="${escapeHtml(friend.id)}">${escapeHtml(friend.name)}</option>`).join("")
      : `<option value="" disabled>追加できる友達がいません</option>`);
  memberSelect.value = "";
  memberSelect.disabled = !candidates.length;
  memberAddBtn.disabled = !candidates.length;
  memberHint.hidden = false;
}

export function updateMemberVisibility(): void {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const enabled = hasMemberAccount() && (!meta || canManagePlan(meta));
  memberField.hidden = !enabled;
  memberField.classList.toggle("is-enabled", enabled);
}

function updateWorkspaceControlVisibility(): void {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const accountId = currentAccount()?.id || "";
  const memberEditor = !meta || Boolean(
    meta.id && accountId && db.members().some((member) =>
      member.plan_id === meta.id && member.user_id === accountId &&
      (member.role === "owner" || member.role === "editor") && member.status === "active"
    )
  );
  const candidateSection = root?.querySelector<HTMLElement>("[data-cand-section]");
  if (candidateSection) candidateSection.hidden = !memberEditor;
}

export function refreshMemberField(): void {
  updateMemberVisibility();
  updateWorkspaceControlVisibility();
  renderMembers();
  renderMemberSelect();
}

export function onMembersClick(event: MouseEvent): void {
  const t = event.target;
  if (!(t instanceof Element)) return;
  const rm = t.closest<HTMLElement>("[data-rm]");
  if (rm) { removeMember(rm.dataset.rm || ""); return; }
  const unclaim = t.closest<HTMLElement>("[data-unclaim]");
  if (unclaim) {
    const meta = state.slug ? TripPlans.get(state.slug) : null;
    if (!meta?.id || !window.confirm("本人紐付けを取り消し、費用・精算・投票を元の未登録メンバーへ戻しますか？")) return;
    void db.undoPlaceholderClaim(meta.id, unclaim.dataset.unclaim || "")
      .then(() => { toast("本人紐付けを取り消しました"); location.reload(); })
      .catch((error) => toast(errorMessage(error) || "本人紐付けを取り消せませんでした"));
    return;
  }
  const pending = t.closest<HTMLElement>("[data-rm-pending]");
  if (pending) { removePendingMember(pending.dataset.rmPending || ""); return; }
  const transfer = t.closest<HTMLElement>("[data-transfer-owner]");
  if (transfer) {
    void transferOwnership(transfer.dataset.transferOwner || "", transfer.dataset.transferName || "");
    return;
  }
  const periodsToggle = t.closest<HTMLElement>("[data-mperiods-toggle]");
  if (periodsToggle) { memberPeriodsOpen = !memberPeriodsOpen; renderMembers(); return; }
  const periodReset = t.closest<HTMLElement>("[data-member-reset]");
  if (periodReset) {
    const id = periodReset.dataset.memberReset || "";
    if (id) {
      model.memberDates[id] = { from: null, to: null };
      persistMemberDates();
      renderMembers();
    }
    return;
  }
  const inv = t.closest<HTMLElement>("[data-invite]");
  if (inv) { void shareInvite(inv.dataset.invite || "", inv.dataset.inviteUser || ""); }
}

// 途中合流/離脱の日付入力。確定した時点で参加期間を保存する。
export function onMembersChange(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  const fromId = input.dataset.memberFrom;
  const toId = input.dataset.memberTo;
  const id = fromId || toId;
  if (!id) return;
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  if (!meta?.id || !canManagePlan(meta)) return;
  const current = model.memberDates[id] || { from: null, to: null };
  const value = input.value || null;
  const next = fromId ? { from: value, to: current.to } : { from: current.from, to: value };
  // 旅行の開始日/終了日と同じ（か外側）なら全日程扱いの null に正規化する。
  // null 端は無制限なので、あとから旅行期間を広げてもその人は全日程のまま追従する。
  if (next.from && model.startDate && next.from <= model.startDate) next.from = null;
  if (next.to && model.endDate && next.to >= model.endDate) next.to = null;
  // 合流が離脱より後なら矛盾。両方クリアして全日程に倒す（サーバ側も同様に無効化）。
  if (next.from && next.to && next.from > next.to) { next.from = null; next.to = null; }
  model.memberDates[id] = next;
  persistMemberDates();
  renderMembers();
}

async function transferOwnership(userId: string, name: string): Promise<void> {
  const meta = state.slug ? TripPlans.get(state.slug) : null;
  const planId = meta?.id || (state.slug ? TripPlans.planIdOf(state.slug) : "");
  if (!meta || !planId || !userId || !canManagePlan(meta)) return;
  if (!window.confirm(`${name}さんへ所有権を移譲しますか？あなたは編集者になります。`)) return;
  try {
    await db.transferPlanOwnership(planId, userId);
    refreshMemberField();
    toast(`${name}さんへ所有権を移譲しました`);
  } catch (error) {
    toast(errorMessage(error) || "所有権を移譲できませんでした");
  }
}

export function commitMemberSelect(): void {
  const v = memberSelect.value.trim();
  if (!v) return;
  addMember(v);
}
export function commitMemberName(): void {
  const name = memberNameInput.value;
  if (!name.trim()) return;
  addPendingMember(name);
  memberNameInput.value = "";
  memberNameInput.focus();
}
export function onMemberNameKeydown(event: KeyboardEvent): void {
  if (event.key !== "Enter" || event.isComposing) return;
  event.preventDefault();
  commitMemberName();
}
export async function shareInvite(name: string, userId = ""): Promise<void> {
  if (state.editorLocked) return;
  if (!model.title.trim()) { toast("先に旅行名を入力してください"); return; }
  if (!state.slug) { state.slug = TripPlans.uniqueSlug(model.title); model.slug = state.slug; }
  if (!(await persist(true))) {
    toast("計画を保存できなかったため、招待を作成しませんでした");
    return;
  }
  const data = buildData();
  const meta = TripPlans.get(state.slug);
  if (meta && !canManagePlan(meta)) { toast("招待できるのは計画の所有者だけです"); return; }
  const planId = TripPlans.planIdOf(state.slug);
  if (!planId) { toast("保存してから招待してください"); return; }
  let link = "";
  let createdInviteId = "";
  try {
    const invite = await db.createInvite(planId, {
      invited_name: name, invited_user_id: userId || undefined, role: "editor",
    });
    createdInviteId = invite.id;
    link = await buildInviteLink({
      v: 1,
      meta: {
        slug: state.slug,
        title: model.title,
        dates: datesString(),
        members: model.members,
        route: (data.cities || []).map((c) => c.name).filter(Boolean).join("→"),
        updatedAt: TripPlans.get(state.slug)?.updatedAt,
      },
      token: invite.token,
      invitedName: name,
      role: "editor",
    });
  } catch (error) {
    // 権限なし・回数制限・期限切れが黙って失敗にならないよう、理由ごと知らせる
    toast(errorMessage(error) || "招待リンクを作成できませんでした");
    return;
  }
  const shareData = {
    title: model.title || "旅行計画",
    text: `「${model.title || "旅行"}」に${name ? `${name}さんを` : ""}招待します`,
    url: link,
  };
  if (navigator.share) {
    try { await navigator.share(shareData); return; }
    catch {
      if (createdInviteId) await db.revokeInvite(planId, createdInviteId).catch(() => undefined);
      void renderActiveInvites();
      return;
    }
  }
  try { await navigator.clipboard.writeText(link); toast("招待リンクをコピーしました"); }
  catch {
    const copied = window.prompt("招待リンクをコピーしてください", link);
    if (copied === null && createdInviteId) await db.revokeInvite(planId, createdInviteId).catch(() => undefined);
  }
  void renderActiveInvites();
}
