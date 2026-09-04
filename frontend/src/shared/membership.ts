// 計画の「参加者か」「編集できるか」を plan_members で判定する。
//
// 旧構造は2系統で判定していた:
//   - PlanMeta.members（表示名の連結文字列）に自分の名前が含まれるか
//   - planPermissions（subjectType "account" | "name"）に行があるか
// 実データではこの2つが噛み合わず（メンバー13名中アカウントと一致は1名）、
// ログイン前後で別 principal になるなどの不具合の温床だった。
// いまは plan_members 1枚が正で、判定はここに集約する。

import { isPublished, planVisibility, type PlanMeta } from "./plans-store";
import * as db from "./db";
import { currentUserId } from "./identity";

function memberRow(plan: PlanMeta): db.PlanMemberRow | undefined {
  const me = currentUserId();
  if (!me) return undefined;
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  if (!planId) return undefined;
  return db.members().find((m) => m.plan_id === planId && m.user_id === me && m.status === "active");
}

function effectiveRole(plan: PlanMeta): db.PlanMemberRow["role"] | null {
  const row = memberRow(plan);
  if (row) return row.role;
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  const stored = planId ? db.planById(planId) : undefined;
  return stored?.owner_user_id && stored.owner_user_id === currentUserId() ? "owner" : null;
}

export function roleOf(plan: PlanMeta): db.PlanMemberRow["role"] | null {
  return effectiveRole(plan);
}

export function roleLabel(role: db.PlanMemberRow["role"] | null): string {
  if (role === "owner") return "Owner";
  if (role === "editor") return "Editor";
  if (role === "viewer") return "Viewer";
  return "Guest";
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
  return Boolean(effectiveRole(plan));
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
  const stored = planId ? db.planById(planId) : undefined;
  if (stored?.source === "sample") return false;
  const role = effectiveRole(plan);
  if (role) return role === "owner" || role === "editor";
  return Boolean(
    currentUserId() && stored?.open_editing && stored.visibility === "public" && stored.status === "published"
  );
}

/** 旅行名・期間・画像など、計画メタ情報を変更できる正式な編集メンバーか。 */
export function canEditPlanMetadata(plan: PlanMeta): boolean {
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  if (planId && db.planById(planId)?.source === "sample") return false;
  const role = effectiveRole(plan);
  return role === "owner" || role === "editor";
}

/** 公開範囲・参加者・外部連携を管理できるのは owner だけ。 */
export function canManagePlan(plan: PlanMeta): boolean {
  const planId = plan.id || db.planBySlug(plan.slug)?.id;
  if (planId && db.planById(planId)?.source === "sample") return false;
  return effectiveRole(plan) === "owner";
}

export function canViewPlan(plan: PlanMeta): boolean {
  if (planVisibility(plan) === "public" && isPublished(plan)) return true;
  return isMemberOf(plan);
}

export { planVisibility };
