import * as TripPlans from "../shared/plans-store";
import { currentUserId } from "../shared/identity";
import { CONFIG } from "./state";

/**
 * 見ている計画を自分の下書きとして複製し、そのまま編集画面へ移る。
 * 元の計画には触らない（参加者も引き継がない）。
 */
export async function copyPlanToMine(button: HTMLButtonElement): Promise<void> {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return;
  if (!currentUserId()) {
    const back = "index.html?plan=" + encodeURIComponent(CONFIG.tripSlug);
    location.href = "login.html?returnTo=" + encodeURIComponent(back);
    return;
  }
  // 既にこの計画のコピーを持っているなら、作り直さずそれを開く。
  const already = TripPlans.existingCopyOf(CONFIG.tripSlug);
  if (already) {
    TripPlans.setActiveSlug(already.slug);
    location.href = "plan-editor.html?plan=" + encodeURIComponent(already.slug);
    return;
  }
  button.disabled = true;
  try {
    const copy = await TripPlans.duplicateAndSave(CONFIG.tripSlug);
    if (!copy) {
      window.alert("コピーできませんでした。読み込みが終わってからもう一度お試しください。");
      return;
    }
    TripPlans.setActiveSlug(copy.slug);
    location.href = "plan-editor.html?plan=" + encodeURIComponent(copy.slug);
  } catch (error) {
    window.alert("コピーを保存できませんでした。" + (error instanceof Error ? error.message : ""));
  } finally {
    button.disabled = false;
  }
}
