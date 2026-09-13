import { currentAccount } from "../shared/account-store";
import { model, state, type Model } from "./editor-state";

const PREFIX = "tabi-plan-editor-draft-v1";
let backupTimer = 0;

interface RecoveryDraft {
  savedAt: string;
  slug: string;
  model: Model;
}

function key(slug = state.slug): string {
  return `${PREFIX}:${currentAccount()?.id || "anonymous"}:${slug || "new"}`;
}

function parsed(raw: string | null): RecoveryDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RecoveryDraft>;
    if (!value.model || typeof value.model !== "object" || typeof value.savedAt !== "string") return null;
    if (!Array.isArray(value.model.memberIds) || !Array.isArray(value.model.days) || !Array.isArray(value.model.cities)) return null;
    return value as RecoveryDraft;
  } catch {
    return null;
  }
}

export function saveRecoveryDraftNow(): void {
  window.clearTimeout(backupTimer);
  try {
    const draft: RecoveryDraft = {
      savedAt: new Date().toISOString(),
      slug: state.slug,
      model: JSON.parse(JSON.stringify(model)) as Model,
    };
    localStorage.setItem(key(), JSON.stringify(draft));
  } catch {
    // 容量不足・プライベートモードでもクラウド保存は継続する。
  }
}

export function scheduleRecoveryDraft(): void {
  window.clearTimeout(backupTimer);
  backupTimer = window.setTimeout(saveRecoveryDraftNow, 100);
}

export function clearRecoveryDraft(): void {
  window.clearTimeout(backupTimer);
  try {
    localStorage.removeItem(key());
    // 初回保存中にslugが決まった場合の旧キーも消す。
    localStorage.removeItem(key(""));
  } catch { /* ignore */ }
}

/** サーバーの内容と違う端末内下書きがあれば、利用者の確認後に復元する。 */
export function restoreRecoveryDraft(): boolean {
  let draft: RecoveryDraft | null = null;
  try {
    draft = parsed(localStorage.getItem(key()));
  } catch { /* ignore */ }
  if (!draft) return false;
  if (JSON.stringify(draft.model) === JSON.stringify(model)) {
    clearRecoveryDraft();
    return false;
  }
  const when = new Date(draft.savedAt).toLocaleString("ja-JP");
  if (!window.confirm(`${when} の未保存の編集内容があります。復元しますか？`)) {
    clearRecoveryDraft();
    return false;
  }
  Object.assign(model, draft.model);
  state.dirty = true;
  state.editRevision += 1;
  return true;
}
