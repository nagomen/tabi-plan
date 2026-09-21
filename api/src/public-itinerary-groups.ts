interface PublicItineraryRow {
  plan_id: string;
  item_date: string | null;
  member_ids?: unknown;
  public_track_key?: string | null;
  public_track_keys?: string[] | null;
  public_day_track_keys?: string[] | null;
}

interface MemberPeriodRow {
  plan_id: string;
  user_id: string;
  from_date: string | null;
  to_date: string | null;
}

function parseMemberIds(value: unknown): string[] | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const ids = parsed.filter((entry): entry is string => typeof entry === "string" && Boolean(entry));
    return ids.length ? [...new Set(ids)] : null;
  } catch {
    return null;
  }
}

function isPresentOn(period: MemberPeriodRow, date: string): boolean {
  if (!date) return true;
  return (!period.from_date || period.from_date <= date) && (!period.to_date || period.to_date >= date);
}

function dayKey(planId: string, date: string): string {
  return `${planId}\u0000${date}`;
}

function memberSetKey(ids: readonly string[] | null): string | null {
  if (!ids?.length) return null;
  return [...new Set(ids)].sort().join(",");
}

function coversEveryone(ids: readonly string[], everyone: ReadonlySet<string>): boolean {
  return everyone.size > 0 && [...everyone].every((id) => ids.includes(id));
}

/**
 * 公開閲覧用に、実際の user_id 集合を人物数も含まない匿名の班キーへ置き換える。
 *
 * 各メンバーが参加する予定の組み合わせで班を作る。全員予定は全タブ共通、重なる予定は
 * 該当する複数班へ表示する。氏名・実ID・班の人数・別日との人物対応は応答から分からない。
 */
export function anonymizePublicItineraryGroups(
  itinerary: PublicItineraryRow[],
  publicPlanIds: ReadonlySet<string>,
  memberPeriods: MemberPeriodRow[],
): void {
  const periodsByPlan = new Map<string, MemberPeriodRow[]>();
  for (const period of memberPeriods) {
    const rows = periodsByPlan.get(period.plan_id) || [];
    rows.push(period);
    periodsByPlan.set(period.plan_id, rows);
  }

  const rowsByDay = new Map<string, PublicItineraryRow[]>();
  for (const row of itinerary) {
    if (!publicPlanIds.has(row.plan_id)) continue;
    const key = dayKey(row.plan_id, row.item_date || "");
    const rows = rowsByDay.get(key) || [];
    rows.push(row);
    rowsByDay.set(key, rows);
  }

  for (const rows of rowsByDay.values()) {
    const first = rows[0];
    const planId = first.plan_id;
    const date = first.item_date || "";
    const parsedByRow = new Map<PublicItineraryRow, string[] | null>();
    const everyone = new Set<string>();

    for (const period of periodsByPlan.get(planId) || []) {
      if (isPresentOn(period, date)) everyone.add(period.user_id);
    }
    for (const row of rows) {
      const ids = parseMemberIds(row.member_ids);
      parsedByRow.set(row, ids);
      for (const id of ids || []) everyone.add(id);
    }

    const subsets = new Map<string, string[]>();
    for (const row of rows) {
      const ids = parsedByRow.get(row);
      const key = memberSetKey(ids || null);
      if (!key || subsets.has(key) || coversEveryone(ids || [], everyone)) continue;
      subsets.set(key, ids || []);
    }
    const subsetRows = [...subsets.entries()];
    const bySignature = new Map<string, string[]>();
    for (const memberId of everyone) {
      const signature = subsetRows
        .filter(([, ids]) => ids.includes(memberId))
        .map(([key]) => key)
        .join("|");
      const members = bySignature.get(signature) || [];
      members.push(memberId);
      bySignature.set(signature, members);
    }
    const internalTracks = [...bySignature.values()];
    const publicTrackKeys = internalTracks.map((_, index) => `public-group-${index + 1}`);
    const hasMultipleTracks = internalTracks.length >= 2;

    for (const row of rows) {
      const memberIds = parsedByRow.get(row);
      const key = memberSetKey(memberIds || null);
      const trackKeys = hasMultipleTracks && key && !coversEveryone(memberIds || [], everyone)
        ? internalTracks.flatMap((trackMembers, index) =>
          trackMembers.some((id) => (memberIds || []).includes(id)) ? [publicTrackKeys[index]] : [])
        : [];
      row.public_track_keys = trackKeys.length ? trackKeys : null;
      row.public_track_key = trackKeys.length === 1 ? trackKeys[0] : null;
      row.public_day_track_keys = hasMultipleTracks ? publicTrackKeys : null;
      row.member_ids = null;
    }
  }
}
