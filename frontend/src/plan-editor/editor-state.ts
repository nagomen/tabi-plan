import * as TripPlans from "../shared/plans-store";
import type { PlanVisibility } from "../shared/plans-store";
import type { Candidate } from "../shared/types";
import { parseISO } from "../shared/date";
import type { IconName } from "../shared/icons";

// ---- モデル -------------------------------------------------------------

export type ItemKind = "sight" | "food" | "move" | "stay" | "todo" | "form";

export type ItemStrKey =
  | "time" | "title" | "place" | "mapQuery" | "note" | "lat" | "lng"
  | "from" | "fromLat" | "fromLng" | "to" | "toLat" | "toLng"
  | "transport" | "duration";

export interface Item {
  id: number;
  kind: ItemKind;
  time: string;
  title: string;
  place: string;
  mapQuery: string;
  note: string;
  lat: string;
  lng: string;
  // 移動用
  from: string;
  fromLat: string;
  fromLng: string;
  to: string;
  toLat: string;
  toLng: string;
  transport: string;
  duration: string;
  /** 宿泊専用：この夜から連泊する泊数（既定 1） */
  nights: number;
  /** この予定の対象メンバー（user_id）。空 = その日の在籍メンバー全員。途中合流の個人移動などに使う。 */
  members: string[];
}

export interface Day {
  date: string;
  area: string;
  items: Item[];     // 観光/食事/移動/予定/手続き
  stay: Item | null; // この夜にチェックインする宿（連泊は nights で表現）
}

/** 指定の日に「滞在中」の宿（連泊対応）。startIndex はチェックイン日。 */
export function stayCovering(dayIndex: number): { startIndex: number; stay: Item } | null {
  for (let i = dayIndex; i >= 0; i--) {
    const s = model.days[i] && model.days[i].stay;
    if (s && i + Math.max(1, s.nights) > dayIndex) return { startIndex: i, stay: s };
  }
  return null;
}

export interface City {
  id: number;
  name: string;
  lat: string;
  lng: string;
  /** この都市に滞在する日（任意）。設定すると日が都市の下にまとまる */
  fromDate: string;
  toDate: string;
}

/** 指定日をカバーする都市（fromDate<=date<=toDate） */
export function cityForDate(date: string): City | null {
  for (const c of model.cities) {
    if (c.fromDate && c.toDate && c.fromDate <= date && date <= c.toDate) return c;
  }
  return null;
}

export interface Model {
  slug: string;
  title: string;
  members: string;
  memberIds: string[];
  pendingMembers: { key: string; name: string }[];
  /** メンバーごとの旅行内参加期間（途中合流/離脱）。null 端は全日程。 */
  memberDates: Record<string, { from: string | null; to: string | null }>;
  note: string;
  cover: string;
  startDate: string;
  endDate: string;
  cities: City[];
  days: Day[];
  candidates: Candidate[];
  visibility?: PlanVisibility;
}

export type GeoTarget = "place" | "from" | "to";

export const KINDS: Record<ItemKind, { label: string; icon: IconName }> = {
  sight: { label: "観光", icon: "camera" },
  food: { label: "食事", icon: "cake" },
  move: { label: "移動", icon: "arrowsRightLeft" },
  stay: { label: "宿泊", icon: "buildingOffice2" },
  todo: { label: "予定", icon: "check" },
  form: { label: "手続き", icon: "documentText" },
};

export const KIND_COLOR: Record<ItemKind, string> = {
  sight: "#0b5a42", food: "#b87418", move: "#22719d", stay: "#cf4f3d", todo: "#68746e", form: "#6246a6",
};

export const TRANSPORTS = ["電車", "新幹線", "飛行機", "車", "バス", "フェリー", "徒歩", "その他"];

/**
 * 行程の行に出す移動手段のアイコン。
 * heroicons に電車・バス・船・徒歩の絵柄がないので、
 * 陸路（車・バス）は truck、鉄道と船は ticket（きっぷを買う移動）に寄せる。
 * 正確な手段名は title と展開後の選択欄に残す。
 */
export const TRANSPORT_ICONS: Record<string, IconName> = {
  電車: "ticket",
  新幹線: "ticket",
  フェリー: "ticket",
  飛行機: "paperAirplane",
  車: "truck",
  バス: "truck",
  徒歩: "user",
  その他: "arrowsRightLeft",
};

// ---- 初期状態 -----------------------------------------------------------

export const params = new URLSearchParams(location.search);
const planParam = (params.get("plan") || "").trim();
export const isNew = !planParam;

export const state = {
  slug: isNew ? "" : TripPlans.safeSlug(planParam),
  dirty: false,
  editRevision: 0,
  saveActionsBusy: false,
  seq: 1,
  openItemId: null as number | null,
  armed: null as { itemId: number; target: GeoTarget } | null,
  // 地図クリックで訪問地の位置を決めるときの対象（都市の id）
  armedCity: null as number | null,
  editorLocked: false,
  metadataLocked: false,
  /** 表示中のステップ（1=期間 / 2=目的地 / 3=行程）。0 は未初期化。 */
  viewStep: 0,
};

export const model: Model = {
  slug: state.slug, title: "", members: "", memberIds: [], pendingMembers: [], memberDates: {}, note: "", cover: "", startDate: "", endDate: "", cities: [], days: [], candidates: [],
};

export function newItem(kind: ItemKind, seed?: Partial<Item>): Item {
  return {
    id: state.seq++, kind,
    time: seed?.time ?? "", title: seed?.title ?? "", place: seed?.place ?? "",
    mapQuery: seed?.mapQuery ?? "", note: seed?.note ?? "",
    lat: seed?.lat ?? "", lng: seed?.lng ?? "",
    from: seed?.from ?? "", fromLat: seed?.fromLat ?? "", fromLng: seed?.fromLng ?? "",
    to: seed?.to ?? "", toLat: seed?.toLat ?? "", toLng: seed?.toLng ?? "",
    transport: seed?.transport ?? "", duration: seed?.duration ?? "",
    nights: seed?.nights ?? 1,
    members: seed?.members ? [...seed.members] : [],
  };
}

// ---- 日付ユーティリティ -------------------------------------------------

export function pad(n: number): string { return n < 10 ? "0" + n : String(n); }
export function datesString(): string {
  const a = parseISO(model.startDate);
  const b = parseISO(model.endDate);
  if (!a || !b) return "";
  const f = (d: Date): string => `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return `${f(a)} - ${f(b)}`;
}
// 時刻文字列を分に変換（並べ替え用）。HH:MM と 朝/昼/夕/夜 に対応。
export function timeOrder(s: string): number {
  const t = String(s || "");
  const m = /(\d{1,2}):(\d{2})/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/朝|午前|モーニング/i.test(t)) return 8 * 60;
  if (/昼|正午|ランチ/i.test(t)) return 12 * 60;
  if (/夕/.test(t)) return 17 * 60;
  if (/夜|ディナー|晩/i.test(t)) return 19 * 60;
  return 9000;
}

export function normalizeToISO(value: string | undefined): string {
  const s = String(value || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  return m ? `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}` : "";
}

export function cityDateDefault(index: number): string {
  const firstDay = model.days[0]?.date || model.startDate || "";
  if (index <= 0) return firstDay;
  const prev = model.cities[index - 1];
  return prev?.toDate || prev?.fromDate || firstDay;
}

export function applyCityDateDefaults(): void {
  if (!model.days.length) return;
  model.cities.forEach((city, index) => {
    if (!city.fromDate) city.fromDate = cityDateDefault(index);
    if (!city.toDate) city.toDate = city.fromDate;
  });
}

// ---- 座標補完・ジオコーディング -----------------------------------------

export function num(s: string): number { return Number(String(s).trim()); }
export function hasLatLng(lat: string, lng: string): boolean {
  return String(lat).trim() !== "" && String(lng).trim() !== "" && !isNaN(num(lat)) && !isNaN(num(lng));
}

export function autoCoords(item: Item, target: GeoTarget): void {
  const [latKey, lngKey] = latLngKeys(target);
  if (hasLatLng(item[latKey], item[lngKey])) return;
  const name = target === "from" ? item.from : target === "to" ? item.to : (item.place || item.mapQuery);
  const hit = TripPlans.coordsFor(name);
  if (hit) { item[latKey] = String(hit.lat); item[lngKey] = String(hit.lng); }
}

export function clearItemCoords(item: Item, target: GeoTarget): void {
  const [latKey, lngKey] = latLngKeys(target);
  item[latKey] = "";
  item[lngKey] = "";
}

export function latLngKeys(target: GeoTarget): [ItemStrKey, ItemStrKey] {
  if (target === "from") return ["fromLat", "fromLng"];
  if (target === "to") return ["toLat", "toLng"];
  return ["lat", "lng"];
}

// ---- 検索・参照ヘルパー -------------------------------------------------

export interface Found { day: Day; item: Item; }
export function findItem(id: number): Found | null {
  for (const day of model.days) {
    for (const it of day.items) if (it.id === id) return { day, item: it };
    if (day.stay && day.stay.id === id) return { day, item: day.stay };
  }
  return null;
}

export function inclusiveDateCount(from: string, to: string): number {
  const a = parseISO(from);
  const b = parseISO(to);
  if (!a || !b || b < a) return 1;
  return Math.floor((b.getTime() - a.getTime()) / 86400000) + 1;
}

export function nowHM(): string {
  const d = new Date();
  return `${d.getHours()}:${pad(d.getMinutes())}`;
}

export const UNTITLED = "無題の旅行";

/**
 * 旅行名以外に何か入力されているか。
 *
 * 以前は旅行名が空だと persist() が即 return していたため、期間・訪問地・
 * 行程を作り込んでも旅行名を入れずに離れると、ローカルにも DB にも
 * 何も残らず消えていた。かといって開いただけで下書きを作ると空の計画が
 * 量産されるので、「実際に何か入れたら残す」を境目にする。
 */
export function hasContent(): boolean {
  if (model.note.trim() || model.startDate || model.endDate) return true;
  if (model.cities.some((c) => c.name.trim())) return true;
  if (model.candidates.length) return true;
  return model.days.some((d) => d.items.length > 0 || d.stay !== null || d.area.trim());
}

/** 保存する価値がある状態か（旅行名が空でも中身があれば下書きとして残す）。 */
export function worthSaving(): boolean {
  return Boolean(model.title.trim()) || hasContent();
}

export function normalizeKind(type: string | undefined): ItemKind {
  const t = String(type || "");
  return (["sight", "food", "move", "stay", "todo", "form"] as ItemKind[]).includes(t as ItemKind) ? (t as ItemKind) : "sight";
}
