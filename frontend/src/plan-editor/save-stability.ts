/**
 * 保存中にモデルが変わった場合、同じrevisionになるまで保存を繰り返す。
 * 公開や画面遷移の直前に「最後の1文字だけ未保存」を作らないための調停処理。
 */
export async function saveLatestRevision(
  saveOnce: () => Promise<boolean>,
  currentRevision: () => number,
): Promise<boolean> {
  for (;;) {
    const revision = currentRevision();
    if (!(await saveOnce())) return false;
    if (currentRevision() === revision) return true;
  }
}
