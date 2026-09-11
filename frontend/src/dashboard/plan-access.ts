import * as TripPlans from "../shared/plans-store";
import { isPublished } from "../shared/plans-store";
import { canEditPlan, canViewPlan, isMemberOf, planHasOwner } from "../shared/membership";
import { currentUserId } from "../shared/identity";
import * as db from "../shared/db";
import { CONFIG, isReadOnly } from "./state";

/** 正式メンバーではない、ログイン済みの公開共同編集者か。 */
export function isOpenEditingVisitor(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const row = db.planBySlug(CONFIG.tripSlug);
  return Boolean(
    meta && row && currentUserId() && !isMemberOf(meta) && row.open_editing &&
    row.visibility === "public" && row.status === "published"
  );
}

/** この計画の DB 上の id。無ければ空文字。 */
export function planId(): string {
  return TripPlans.planIdOf(CONFIG.tripSlug);
}

/** 参加者の user_id。表示名ではなくこちらを操作に使う。 */
export function memberIds(): string[] {
  const meta = TripPlans.get(CONFIG.tripSlug);
  const ids = meta?.memberIds || [];
  const me = currentUserId();
  // 自分がまだメンバーでない計画でも、自分名義で費用を入れられるようにする
  return me && !ids.includes(me) && !isReadOnly() ? [me, ...ids] : ids;
}

export function isEditableLocalPlan(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return !isReadOnly() && CONFIG.mode === "local" && Boolean(meta && isMemberOf(meta) && canEditPlan(meta));
}

/** タスクを編集・保存できるのはこの端末のローカル計画のみ。 */
export function tasksEditable(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return !isReadOnly() && CONFIG.mode === "local" && Boolean(meta && isMemberOf(meta) && canEditPlan(meta));
}

export function canUseWorkspaceView(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return !isReadOnly();
  if (isMemberOf(meta)) return true;
  if (!planHasOwner(meta) && !isReadOnly()) return true;
  return false;
}

/**
 * 読み取り専用ビュー判定。
 * 他人の公開計画は plans ホームから `?view=1` 付きで開かれる（明示シグナル）。
 * 加えて、持ち主が居る計画（権限行 or メンバー名がある）の非メンバーなら読み取り専用にする。
 * 持ち主が居ない計画は、名前未設定の本人までロックしないよう planHasOwner でガードする。
 */
export function computeReadOnly(): boolean {
  // 公開共同編集はログイン済み利用者だけ。正式メンバー権限とは分離する。
  if (isOpenEditingVisitor()) return false;
  const forcedView = new URLSearchParams(location.search).get("view") === "1";
  if (forcedView) return true;
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return false;
  if (canEditPlan(meta)) return false;
  // 公開されている計画は、参加者でなければ閲覧のみ。
  //
  // ここは planHasOwner だけで判断していたが、bootstrap は自分が
  // 関わらない計画の参加者行を返さない。そのため人の公開計画は
  // 「持ち主が居ない」と見えてしまい、編集できる扱いになっていた
  // （保存はサーバーが 403 で止めるが、編集ボタンが出て、
  //   代わりに出すべき「コピーして自分用に作る」が出なかった）。
  if (isPublished(meta)) return true;
  // 未公開の計画で参加者も権限行も無いものは、持ち主が居ないと見なして
  // ロックしない（ログアウト状態で作った下書きを、本人が二度と
  // 編集できなくなるのを防ぐ）。
  return planHasOwner(meta);
}

export function computeAccessDenied(): boolean {
  const meta = TripPlans.get(CONFIG.tripSlug);
  return Boolean(meta) && !canViewPlan(meta!);
}
