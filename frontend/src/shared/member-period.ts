// メンバーの旅行内参加期間（途中合流/離脱）の純粋ロジック。
// DB・DOM に依存しないので単体テストしやすい。端が null なら無制限。

export interface MemberPeriod {
  user_id: string;
  from_date: string | null;
  to_date: string | null;
}

/** date（YYYY-MM-DD）がこの参加期間に含まれるか。date 未指定なら常に true。 */
export function isMemberPresentOn(
  period: { from_date: string | null; to_date: string | null },
  date: string,
): boolean {
  if (!date) return true;
  if (period.from_date && date < period.from_date) return false;
  if (period.to_date && date > period.to_date) return false;
  return true;
}

/** date に在籍しているメンバーの user_id だけを返す。date 未指定なら全員。 */
export function presentMemberIds(periods: MemberPeriod[], date: string): string[] {
  return periods.filter((period) => isMemberPresentOn(period, date)).map((period) => period.user_id);
}
