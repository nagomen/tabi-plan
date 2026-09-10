import { WEEKDAYS } from "../shared/date";

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
/** 地図ラベル用の短い日付（YY/M/D）。 */
export function fmtShort(d: Date): string {
  return `${String(d.getFullYear()).slice(2)}/${d.getMonth() + 1}/${d.getDate()}`;
}
/** ポップアップ用の読みやすい日付（YYYY年M月D日(曜)）。 */
export function fmtFull(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
}
export function fmtMonthDay(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}
