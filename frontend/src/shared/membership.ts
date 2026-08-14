// 計画の「参加者か」「編集できるか」を plan_members で判定する。
//
// 旧構造は2系統で判定していた:
//   - PlanMeta.members（表示名の連結文字列）に自分の名前が含まれるか
//   - planPermissions（subjectType "account" | "name"）に行があるか
// 実データではこの2つが噛み合わず（メンバー13名中アカウントと一致は1名）、
// ログイン前後で別 principal になるなどの不具合の温床だった。
// いまは plan_members 1枚が正で、判定はここに集約する。

import { splitNames } from "./friend-store";
import { isPublished, planVisibility, type PlanMeta } from "./plans-store";
import * as db from "./db";
import { currentUserId } from "./identity";

/** 計画のメンバー名一覧（表示用）。 */
export function membersOf(plan: PlanMeta): string[] {
  if (plan.memberIds && plan.memberIds.length) {
    return plan.memberIds.map((id) => db.nameOf(id)).filter(Boolean);
  }
  return splitNames(plan.members);
}

function memberRow(plan: PlanMeta): db.PlanMemberRow | undefined {
  const me = currentUserId();
  if (!me) return undefined;
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  if (!planId) return undefined;
  return db.members().find((m) => m.plan_id === planId && m.user_id === me);
}

export function roleOf(plan: PlanMeta): db.PlanMemberRow["role"] | null {
  return memberRow(plan)?.role || null;
}

export function ownerNameOf(plan: PlanMeta): string {
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  const stored = planId ? db.planById(planId) : undefined;
  const ownerId = stored?.owner_user_id || db.members().find(
    (member) => member.plan_id === planId && member.role === "owner" && member.status === "active",
  )?.user_id;
  return ownerId ? db.nameOf(ownerId) : "";
}

/** 自分がこの計画の参加者か。利用者が未確定なら false。 */
export function isMemberOf(plan: PlanMeta): boolean {
  return Boolean(memberRow(plan));
}

/**
 * この計画を「自分の計画」として扱うか。
 * 利用者が未確定な訪問者は「自分」を持たないので false。
 */
export function isMine(plan: PlanMeta): boolean {
  return isMemberOf(plan);
}

/**
 * 持ち主が確定している計画か（参加者が1人でも居るか）。
 * 誰も居ない計画は、利用者未確定でも締め出さない
 * （＝名前を決める前に作った計画を、本人が編集できなくなるのを防ぐ）。
 */
export function planHasOwner(plan: PlanMeta): boolean {
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  if (!planId) return false;
  if (db.planById(planId)?.owner_user_id) return true;
  return db.members().some((member) =>
    member.plan_id === planId && member.role === "owner" && member.status === "active"
  );
}

export function canEditPlan(plan: PlanMeta): boolean {
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  const row = memberRow(plan);
  if (row) return row.role === "owner" || row.role === "editor";
  const stored = planId ? db.planById(planId) : undefined;
  return Boolean(
    currentUserId() && stored?.open_editing && stored.visibility === "public" && stored.status === "published"
  );
}

/** 公開範囲・参加者・外部連携を管理できるのは owner だけ。 */
export function canManagePlan(plan: PlanMeta): boolean {
  return memberRow(plan)?.role === "owner";
}

export function canViewPlan(plan: PlanMeta): boolean {
  if (planVisibility(plan) === "public" && isPublished(plan)) return true;
  return isMemberOf(plan);
}

export { planVisibility };
