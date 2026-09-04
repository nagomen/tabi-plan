// 一部メンバーだけの予定（members 指定）で行程が分かれる日を「班」に割る純ロジック。
// member-period.ts と同じく DB・DOM に依存しないので単体テストしやすい。

export interface DayTrack {
  /** 班の識別子。予定の対象メンバー集合のキー。残りメンバー班は REST_TRACK_KEY。 */
  key: string;
  memberIds: string[];
}

/** どの班の予定にも入っていない在籍メンバーの班キー。 */
export const REST_TRACK_KEY = "@rest";

/** 予定の対象メンバー集合を正規化したキー。空＝全員対象は null。 */
export function memberSetKey(members: readonly string[] | undefined): string | null {
  const ids = [...new Set((members || []).filter(Boolean))].sort();
  return ids.length ? ids.join(",") : null;
}

/** members が在籍メンバー全員を含むか（＝実質「全員の予定」）。在籍が不明なら false。 */
function coversEveryone(memberIds: readonly string[], presentIds: readonly string[]): boolean {
  const present = presentIds.filter(Boolean);
  if (!present.length) return false;
  const ids = new Set(memberIds);
  return present.every((id) => ids.has(id));
}

/**
 * その日の班。一部メンバーだけの予定があるとき、対象メンバー集合ごとに1班と、
 * どの班にも入らない在籍メンバー（presentIds の残り）の班に割る。
 * 在籍メンバー全員が入っている予定は「全員の予定」なので班を作らない
 * （どの班のタブにも共通の予定として表示する）。
 * 班が2つ以上に分かれない日は空配列（＝タブは出さず従来表示）。
 */
export function dayTracks(
  itemMembers: (readonly string[] | undefined)[],
  presentIds: readonly string[],
): DayTrack[] {
  const subsets = new Map<string, string[]>();
  for (const members of itemMembers) {
    const key = memberSetKey(members);
    if (!key || subsets.has(key)) continue;
    const ids = key.split(",");
    if (coversEveryone(ids, presentIds)) continue;
    subsets.set(key, ids);
  }
  if (!subsets.size) return [];
  const covered = new Set([...subsets.values()].flat());
  const tracks: DayTrack[] = [...subsets.entries()].map(([key, memberIds]) => ({ key, memberIds }));
  const rest = presentIds.filter((id) => id && !covered.has(id));
  if (rest.length) tracks.push({ key: REST_TRACK_KEY, memberIds: [...new Set(rest)] });
  return tracks.length >= 2 ? tracks : [];
}

/** 表示する班を 選択キー → 本人の所属班 → 先頭 の順で決める。班が無い日は null。 */
export function pickTrack(
  tracks: DayTrack[],
  chosenKey: string | undefined,
  youId: string,
): DayTrack | null {
  if (!tracks.length) return null;
  return tracks.find((track) => track.key === chosenKey)
    || (youId ? tracks.find((track) => track.memberIds.includes(youId)) : undefined)
    || tracks[0];
}

/**
 * この予定を track の班で表示するか。
 * members 空、または在籍メンバー全員入りの予定は「全員の予定」としてどの班でも表示する。
 */
export function isItemInTrack(
  members: readonly string[] | undefined,
  track: DayTrack,
  presentIds: readonly string[] = [],
): boolean {
  const key = memberSetKey(members);
  if (!key) return true;
  if (coversEveryone(key.split(","), presentIds)) return true;
  return key === track.key;
}
