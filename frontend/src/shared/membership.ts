// 計画の「メンバー判定」を全画面で共有する。
// 所有＝「その計画の参加メンバーに自分（＝端末のユーザー名）が含まれるか」。
// マイページ・計画一覧ホーム・ダッシュボードの読み取り専用判定で使う。

import { splitNames } from "./friend-store";
import { getUser } from "./user-store";
import { planVisibility, type PlanMeta } from "./plans-store";
import * as Permissions from "./permissions-store";

/** 計画のメンバー名一覧（「、」「,」「/」「･」区切り）。 */
export function membersOf(plan: PlanMeta): string[] {
  return splitNames(plan.members);
}

/** 現在のユーザー名がこの計画のメンバーに含まれるか。名前未設定なら常に false。 */
export function isMemberOf(plan: PlanMeta): boolean {
  if (Permissions.isParticipant(plan.slug, membersOf(plan))) return true;
  const name = getUser().name;
  return Boolean(name) && membersOf(plan).includes(name);
}

/**
 * この計画を「自分の計画」として扱うか。
 * ログアウト/名前未設定の訪問者は「自分」を持たないので false。
 */
export function isMine(plan: PlanMeta): boolean {
  if (Permissions.canEdit(plan.slug)) return true;
  return getUser().name ? isMemberOf(plan) : false;
}

export function canEditPlan(plan: PlanMeta): boolean {
  return Permissions.canEdit(plan.slug) || isMemberOf(plan);
}

export function canViewPlan(plan: PlanMeta): boolean {
  return Permissions.canView(plan.slug, planVisibility(plan)) || isMemberOf(plan);
}

/** planVisibility を再エクスポート（呼び出し側の import をまとめやすくする） */
export { planVisibility };
