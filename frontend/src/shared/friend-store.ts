// 友達（メンバー候補）。今は専用リストを持たず、過去の計画のメンバーから自動収集する。
// 将来、明示的な友達リストや連絡先連携に差し替える場合もここに集約する。

import * as TripPlans from "./plans-store";

/** メンバー文字列を名前配列に分解（「、」「,」「/」「･」区切り）。 */
export function splitNames(value: string | undefined): string[] {
  return String(value || "")
    .split(/[、,／/]|\s*\/\s*|\s*･\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** これまでの計画に登場したメンバー名を、exclude を除いて重複なく返す。 */
export function friendCandidates(exclude: string[] = []): string[] {
  const ex = new Set(exclude.map((s) => s.trim()).filter(Boolean));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const plan of TripPlans.list()) {
    for (const name of splitNames(plan.members)) {
      if (!ex.has(name) && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    }
  }
  return out.sort((a, b) => a.localeCompare(b, "ja"));
}
