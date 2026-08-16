/** ブラウザのローカル日付を YYYY-MM-DD で返す。テスト・デモ用の上書きを優先する。 */
export function localDateISO(override = "", now = new Date()): string {
  if (override) return override;
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
