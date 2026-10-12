// 表示用の書式。DOM に依存しない純粋関数だけを置く。

export const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const weekday = ["日", "月", "火", "水", "木", "金", "土"];

export function yenRange(minimum: number, maximum: number): string {
  return minimum === maximum ? yen.format(maximum) : `${yen.format(minimum)}〜${yen.format(maximum)}`;
}

export function displayDate(iso: string, includeYear = true): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso || "未定";
  const [, year, month, day] = match;
  const dayOfWeek = weekday[new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay()];
  return `${includeYear ? `${Number(year)}年` : ""}${Number(month)}月${Number(day)}日（${dayOfWeek}）`;
}

export function todayInJapan(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** 「2026年12月」「2027年1月」→「12月・1月」。月の表記は保存データから作り、コードに固定しない。 */
export function monthNames(labels: string[]): string {
  const names = labels.map((label) => /(\d{1,2})月/.exec(label)?.[1]).filter(Boolean).map((month) => `${Number(month)}月`);
  return names.length ? names.join("・") : "該当月";
}
