/** ブラウザのローカル日付を YYYY-MM-DD で返す。テスト・デモ用の上書きを優先する。 */
export function localDateISO(override = "", now = new Date()): string {
  if (override) return override;
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 日本語の曜日（0=日 … 6=土）。 */
export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** Date の曜日を日本語1文字で返す。 */
export function weekday(d: Date): string {
  return WEEKDAYS[d.getDay()];
}

/** "YYYY-MM-DD" をローカル Date へ。形式外・不正日付は null。 */
export function parseISO(value: string | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Date を "YYYY-MM-DD" へ。 */
export function toISO(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Date を "M/D" へ。 */
export function mdOf(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** "YYYY-MM-DD…" を "M/D" へ。パースできなければ元文字列を返す。 */
export function mdLabel(iso: string | undefined): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${Number(m[1])}/${Number(m[2])}` : iso || "";
}
