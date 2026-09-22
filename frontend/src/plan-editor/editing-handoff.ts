// 計画エディタは「新規作成のウィザード」に役割を絞る。
// 既にある計画の編集は観覧画面（index.html の編集モード）へ一本化するので、
// このタブで作った下書き以外は、開かれた時点でそちらへ渡す。

const KEY_PREFIX = "tabi-plan-editor-draft:";

/** このタブのウィザードが作った下書きとして覚える。 */
export function markEditorDraft(slug: string): void {
  if (!slug) return;
  try { sessionStorage.setItem(KEY_PREFIX + slug, "1"); } catch { /* 保存できなくても動作は変えない */ }
}

function isEditorDraft(slug: string): boolean {
  try { return sessionStorage.getItem(KEY_PREFIX + slug) === "1"; } catch { return false; }
}

/**
 * 既存計画のURLで開かれていたら観覧画面の編集モードへ送る。
 * 送ったときは true を返す（呼び出し側はそれ以上の初期化をしない）。
 */
export function handOffExistingPlanToDashboard(): boolean {
  const slug = (new URLSearchParams(location.search).get("plan") || "").trim();
  if (!slug || isEditorDraft(slug)) return false;
  location.replace(`index.html?plan=${encodeURIComponent(slug)}#edit`);
  return true;
}
