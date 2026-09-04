// 旧データのメンバー文字列を扱うための互換ユーティリティ。

/** メンバー文字列を名前配列に分解（「、」「,」「/」「･」区切り）。 */
export function splitNames(value: string | undefined): string[] {
  return String(value || "")
    .split(/[、,／/]|\s*\/\s*|\s*･\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
