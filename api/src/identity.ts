/** 名前・メールの検索キーをDBと同じ規則に正規化する。 */
export function identityKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

/** ざっくりしたメール形式チェック（DB制約より手前の入力バリデーション用）。 */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
