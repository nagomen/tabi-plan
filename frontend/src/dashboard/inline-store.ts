// 観覧画面のインライン編集で、計画本体（LocalPlanData）へ変更を当てて保存する層。
//
// 保存するのは画面が描いている TripData ではなく、ストアの計画本体。TripData は
// 表示用に間引いた形で、旅行の開始日・終了日・カバー画像・参加者IDを持たない。
// これをそのまま保存へ戻すと、予定を1件直しただけでカバー画像や参加者が消える。
// 変更は必ず getData() で読み直した本体へ当ててから保存する。

import * as TripPlans from "../shared/plans-store";
import * as db from "../shared/db";
import { errorMessage } from "../shared/dom";
import { parseISO, toISO } from "../shared/date";
import type { ItineraryItem, RouteCity } from "../shared/types";
import { CONFIG, hooks } from "./state";

export type PlanData = TripPlans.LocalPlanData;

let saving = false;

export function setStatus(status: HTMLElement | null, text: string): void {
  if (status) status.textContent = text;
}

/** 編集中の計画本体を読み直す。取れなければ null。 */
export function planData(): PlanData | null {
  return TripPlans.getData(CONFIG.tripSlug);
}

/** 保存後（および保存に失敗して読み直したあと）の表示をストアに合わせる。 */
export function refresh(): void {
  hooks.renderData(TripPlans.toDashboardData(planData()), CONFIG.mode);
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof db.ApiRequestError &&
    (error.code === "plan_version_conflict" || (error.status === 409 && /別の端末で更新/.test(error.message)));
}

/** 計画本体に変更を当てて保存する。成功したら true。 */
export async function commit(status: HTMLElement | null, apply: (data: PlanData) => void): Promise<boolean> {
  if (saving) return false;
  const meta = TripPlans.get(CONFIG.tripSlug);
  const data = planData();
  if (!meta || !data) {
    setStatus(status, "計画を読み込めませんでした。時間をおいて開き直してください。");
    return false;
  }
  apply(data);
  saving = true;
  setStatus(status, "保存しています…");
  const checkpoint = db.mutationCheckpoint();
  // 参加者は既存のIDをそのまま渡す。表示名から引き直すと、名前が解決できない
  // 参加者が抜け落ちる。
  const saved = TripPlans.saveLocalPlan(CONFIG.tripSlug, data, meta.memberIds);
  if (!saved) {
    setStatus(status, "保存できませんでした。ログイン状態を確認してください。");
    saving = false;
    return false;
  }
  try {
    await db.flushMutations(checkpoint);
    refresh();
    return true;
  } catch (error) {
    // flushMutations は失敗時にサーバーから読み直す。相手の変更を上書きしない
    // よう、ここでは画面をストアの内容へ戻すだけにする。
    setStatus(status, isVersionConflict(error)
      ? "別の端末で更新されています。最新の内容を読み込みました。もう一度お試しください。"
      : errorMessage(error) || "保存できませんでした。");
    refresh();
    return false;
  } finally {
    saving = false;
  }
}

// ---- 日付の小道具 -------------------------------------------------------

/** ISO 日付を days 日ずらす。日付として読めなければそのまま返す。 */
export function shiftDate(iso: string, days: number): string {
  const date = parseISO(iso);
  if (!date) return iso;
  date.setDate(date.getDate() + days);
  return toISO(date);
}

function daysBetween(from: string, to: string): number | null {
  const a = parseISO(from);
  const b = parseISO(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** 旅程の日付一覧（開始日が未設定の計画では予定の日付から補う）。 */
export function itineraryDates(data: PlanData): string[] {
  return [...new Set((data.itinerary || []).map((item) => item.date).filter(Boolean))].sort();
}

/** 旅行の開始日。未設定なら最初の予定の日。 */
export function tripStart(data: PlanData): string {
  return data.trip?.startDate || itineraryDates(data)[0] || "";
}

/** 旅行の終了日。未設定なら最後の予定の日。 */
export function tripEnd(data: PlanData): string {
  const dates = itineraryDates(data);
  return data.trip?.endDate || dates[dates.length - 1] || tripStart(data);
}

/** その日が旅程の何日目かを Day ラベルにする。求められなければ undefined。 */
export function planDayLabel(data: PlanData, date: string): string | undefined {
  const start = tripStart(data);
  if (!start || !date || date < start) return undefined;
  const diff = daysBetween(start, date);
  return diff != null && diff >= 0 ? `Day ${diff + 1}` : undefined;
}

/** 保存用の期間ラベル（計画エディタと同じ「YYYY/M/D - YYYY/M/D」形式）。 */
export function tripDatesLabel(start: string, end: string): string {
  const format = (iso: string): string => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    return match ? `${match[1]}/${Number(match[2])}/${Number(match[3])}` : iso;
  };
  return start === end ? format(start) : `${format(start)} - ${format(end)}`;
}

/** 期間を書き換え、Day ラベルを日付から付け直す。 */
function setRange(data: PlanData, start: string, end: string): void {
  data.trip = { ...data.trip, startDate: start, endDate: end, dates: tripDatesLabel(start, end) };
  renumberDays(data);
}

/** 予定の Day ラベルを、いまの日付と開始日から付け直す。 */
export function renumberDays(data: PlanData): void {
  data.itinerary = (data.itinerary || []).map((item) => ({
    ...item,
    day: planDayLabel(data, item.date) || item.day || "",
  }));
}

// ---- 予定 ---------------------------------------------------------------

/** 画面の index と itemId から、計画本体の中の位置を探す。 */
export function locate(data: PlanData, itemId: string, index: number): number {
  if (itemId) {
    const found = data.itinerary.findIndex((item) => item.itemId === itemId);
    if (found >= 0) return found;
  }
  return index >= 0 && index < data.itinerary.length ? index : -1;
}

/** 予定1件を計画本体へ当てる。at が負なら追加。既存の座標などは引き継ぐ。 */
export function applyItemEdit(data: PlanData, at: number, values: Partial<ItineraryItem> & { date: string }): void {
  const previous = at >= 0 ? data.itinerary[at] : undefined;
  const next: ItineraryItem = {
    ...(previous || {} as ItineraryItem),
    ...values,
    day: planDayLabel(data, values.date) || previous?.day || "",
    mapQuery: values.mapQuery || previous?.mapQuery || values.place || "",
  };
  if (at >= 0) data.itinerary[at] = next;
  else data.itinerary.push(next);
}

export interface ItemKey { itemId: string; index: number }

/** 表示順 keys のとおりに、その日の予定を並べ替える。位置を特定できなければ false。 */
export function applyReorder(data: PlanData, keys: ItemKey[]): boolean {
  const positions = keys.map((key) => locate(data, key.itemId, key.index));
  if (positions.some((position) => position < 0) || new Set(positions).size !== positions.length) return false;
  const moved = positions.map((position) => data.itinerary[position]);
  [...positions].sort((a, b) => a - b).forEach((slot, order) => { data.itinerary[slot] = moved[order]; });
  return true;
}

/** 地図で動かした地点の座標を書き戻す。move の出発地・到着地は別の列を持つ。 */
export function applyPointMove(data: PlanData, itemId: string, role: string, lat: number, lng: number): boolean {
  const at = locate(data, itemId, -1);
  if (at < 0) return false;
  const item = data.itinerary[at];
  if (role === "origin") data.itinerary[at] = { ...item, originLat: lat, originLng: lng };
  else if (role === "destination") data.itinerary[at] = { ...item, destinationLat: lat, destinationLng: lng };
  else data.itinerary[at] = { ...item, lat, lng };
  return true;
}

// ---- 旅行情報 -----------------------------------------------------------

/** 旅行情報を計画本体へ当てる。メモ・参加者など他の項目は触らない。 */
export function applyTripEdit(
  data: PlanData,
  values: { title: string; start: string; end: string; cover: string },
): void {
  data.trip = { ...data.trip, title: values.title, cover: values.cover };
  setRange(data, values.start, values.end);
}

// ---- 日程（日の追加・削除）---------------------------------------------

/** 旅行の最後に空の1日を足す。 */
export function applyDayAppend(data: PlanData): void {
  const start = tripStart(data);
  const end = tripEnd(data);
  if (!start || !end) return;
  setRange(data, start, shiftDate(end, 1));
}

/**
 * date の翌日に空の1日を差し込む。それ以降の予定と都市は1日ずつ後ろへずらす。
 */
export function applyDayInsert(data: PlanData, date: string): void {
  const start = tripStart(data);
  const end = tripEnd(data);
  if (!start || !end || !date) return;
  data.itinerary = (data.itinerary || []).map((item) =>
    item.date && item.date > date ? { ...item, date: shiftDate(item.date, 1) } : item);
  data.cities = (data.cities || []).map((city) => ({
    ...city,
    fromDate: city.fromDate && city.fromDate > date ? shiftDate(city.fromDate, 1) : city.fromDate,
    toDate: city.toDate && city.toDate > date ? shiftDate(city.toDate, 1) : city.toDate,
  }));
  setRange(data, start, shiftDate(end, 1));
}

/**
 * その日をまるごと無くす。その日の予定は消し、以降の予定と都市は1日ずつ前へ詰め、
 * 旅行の期間を1日縮める。消える予定の件数は呼び出し側が先に確認する。
 */
export function applyDayRemove(data: PlanData, date: string): void {
  const start = tripStart(data);
  const end = tripEnd(data);
  if (!start || !end || !date || start === end) return;
  data.itinerary = (data.itinerary || [])
    .filter((item) => item.date !== date)
    .map((item) => (item.date && item.date > date ? { ...item, date: shiftDate(item.date, -1) } : item));
  data.cities = (data.cities || [])
    .map((city) => ({
      ...city,
      fromDate: city.fromDate && city.fromDate > date ? shiftDate(city.fromDate, -1) : city.fromDate,
      toDate: city.toDate && city.toDate >= date ? shiftDate(city.toDate, -1) : city.toDate,
    }))
    .filter((city) => !city.fromDate || !city.toDate || city.fromDate <= city.toDate);
  setRange(data, start, shiftDate(end, -1));
}

/** その日の予定の件数（削除前の確認に使う）。 */
export function itemsOnDate(data: PlanData, date: string): ItineraryItem[] {
  return (data.itinerary || []).filter((item) => item.date === date);
}

// ---- 都市 ---------------------------------------------------------------

/** 滞在都市の一覧をまるごと置き換える。名前と期間が揃っている行だけ残す。 */
export function applyCityEdit(data: PlanData, cities: RouteCity[]): void {
  data.cities = cities
    .map((city) => ({ ...city, name: String(city.name || "").trim() }))
    .filter((city) => city.name && city.fromDate && city.toDate && city.fromDate <= city.toDate);
}
