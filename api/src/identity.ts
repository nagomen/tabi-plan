/** 名前・メールの検索キーをDBと同じ規則に正規化する。 */
export function identityKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}
