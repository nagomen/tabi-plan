import { readGlobalTripConfig, resolvedTripConfig, type TripConfig } from "../shared/config";
import * as TripPlans from "../shared/plans-store";
import type { DayGroup, LeafletState } from "./types";
import { setTripDocumentTitle } from "../shared/page-meta";
import type { TripData, TripLink } from "../shared/types";

// ---- 補助型 -------------------------------------------------------------

interface AppState {
  data: TripData;
  days: DayGroup[];
  active: number;
  /** 「この日の予定」フィードで下に展開して表示している最後の日 index */
  viewEnd: number;
  source: string;
}

// ---- 設定 ---------------------------------------------------------------

const BASE_TRIP_CONFIG = readGlobalTripConfig();
const PLAN_OVERRIDE = TripPlans.resolveConfigOverride(BASE_TRIP_CONFIG) || {};
export const CONFIG: TripConfig = resolvedTripConfig(PLAN_OVERRIDE);
setTripDocumentTitle(CONFIG.tripTitle, (title) => `${title}ダッシュボード`, "");

/** 共有ストアを読み終えたあと、開いている計画の実体で CONFIG を補正する。 */
export function applyPlanConfig(): void {
  const meta = TripPlans.get(CONFIG.tripSlug);
  if (!meta) return;
  CONFIG.tripTitle = meta.title || CONFIG.tripTitle;
  CONFIG.mode = meta.source === "sample" ? "sample" : "local";
  setTripDocumentTitle(CONFIG.tripTitle, (title) => `${title}ダッシュボード`, "");
}

// ---- サンプルデータ -----------------------------------------------------

export const SAMPLE: TripData = {
  trip: {
    title: CONFIG.tripTitle || "サンプル旅行",
    dates: "2027/3/10 - 3/12",
    members: "参加者A / 参加者B",
    note: "共有メモ: 予約番号や住所などの機密情報は公開ページに載せないでください。",
  },
  links: [
    { key: "maps", label: "My Maps", icon: "地", url: "https://www.google.com/maps/d/", caption: "Google My Maps" },
    { key: "photos", label: "写真", icon: "写", url: "https://photos.google.com/", caption: "Google Photos" },
  ],
  settlement: {
    paid: "¥3,200",
    paidLabel: "精算額",
    expenseTotal: "¥28,400",
    progress: 50,
    yourPaid: "¥14,200",
    yourDue: "¥3,200",
    transfers: [
      { from: "参加者B", to: "参加者A", amount: 3200, amountLabel: "¥3,200" },
    ],
    rateDetails: [
      { date: "2027-03-10", payer: "参加者A", title: "夕食", currency: "JPY", amount: "¥8,000", rateDate: "2027-03-10", rate: 1, converted: "¥8,000" },
      { date: "2027-03-11", payer: "参加者B", title: "タクシー", currency: "USD", amount: "USD 35", rateDate: "2027-03-11", rate: 150, converted: "¥5,250" },
    ],
    expenseDetails: [
      { date: "2027-03-10", payer: "参加者A", category: "食費", title: "夕食", mode: "全員で等分", amountLabel: "¥8,000", convertedLabel: "¥8,000", myShareLabel: "¥4,000", targetNames: ["参加者A", "参加者B"], shares: [{ name: "参加者A", amount: 4000, amountLabel: "¥4,000" }] },
      { date: "2027-03-11", payer: "参加者B", category: "交通", title: "タクシー", mode: "選んだ人だけで等分", amountLabel: "USD 35", convertedLabel: "¥5,250", myShareLabel: "¥2,625", targetNames: ["参加者A", "参加者B"], shares: [{ name: "参加者A", amount: 2625, amountLabel: "¥2,625" }] },
    ],
    rateWarnings: [],
    baseCurrency: "JPY",
    photoTitle: "旅行アルバム",
    photoMeta: "Google Photos",
  },
  checklist: [
    { label: "交通と宿の予約状況確認", done: true },
    { label: "保険と緊急連絡先の確認", done: false },
    { label: "モバイル通信の設定", done: false },
    { label: "荷物の最終確認", done: false },
  ],
  localInfo: [
    { country: "日本", currencyCode: "JPY", currencyName: "円", approxRate: "1 JPY = ¥1", rateUpdatedAt: "", feeFreeAtm: "必要に応じて記入", atmBest: "", atmFee: "", atmNote: "", rideBest: "タクシーアプリ", rideAlt: "公共交通", paymentNote: "国内旅行では原則JPYで入力" },
    { country: "海外渡航先", currencyCode: "USD", currencyName: "現地通貨", approxRate: "最新レートを確認", rateUpdatedAt: "", feeFreeAtm: "現地で確認", atmBest: "", atmFee: "", atmNote: "DCCは原則拒否", rideBest: "", rideAlt: "", paymentNote: "カードと少額現金を併用" },
  ],
  itinerary: [
    { date: "2027-03-10", day: "Day 1", area: "東京", time: "10:00", type: "move", typeLabel: "移動", title: "集合", place: "東京駅", note: "集合場所を確認。", lat: 35.6812, lng: 139.7671, mapQuery: "東京駅", weather: "" },
    { date: "2027-03-10", day: "Day 1", area: "京都", time: "13:00", type: "move", typeLabel: "移動", title: "京都へ移動", place: "京都駅", note: "新幹線または航空券を確認。", lat: 34.9858, lng: 135.7588, mapQuery: "京都駅", weather: "" },
    { date: "2027-03-10", day: "Day 1", area: "京都", time: "18:30", type: "food", typeLabel: "食事", title: "夕食", place: "京都市内", note: "予約名を確認。", lat: 35.0116, lng: 135.7681, mapQuery: "京都市", weather: "" },
    { date: "2027-03-11", day: "Day 2", area: "京都", time: "09:30", type: "sight", typeLabel: "観光", title: "市内観光", place: "京都市内", note: "混雑状況を見て順番を調整。", lat: 35.0116, lng: 135.7681, mapQuery: "京都市 観光", weather: "" },
  ],
};

// ---- 状態 ---------------------------------------------------------------

export const state: AppState = { data: SAMPLE, days: [], active: 0, viewEnd: 0, source: "sample" };
let mobileView = "home";

export function getMobileView(): string {
  return mobileView;
}

export function setMobileView(view: string): void {
  mobileView = view;
}
export const leafletState: LeafletState = { map: null, layer: null, followActive: true };
let editingExpenseId: string | null = null;

export function getEditingExpenseId(): string | null {
  return editingExpenseId;
}

export function setEditingExpenseId(id: string | null): void {
  editingExpenseId = id;
}
export function linkByKey(key: string): TripLink | Partial<TripLink> {
  return state.data.links.find((link) => link.key === key) || {};
}

interface RenderHooks {
  renderBase(): void;
  renderActive(): void;
  renderData(data: TripData | null | undefined, source?: string): void;
  syncData(isInitial: boolean): Promise<void>;
}

function unwired(): never {
  throw new Error("render hooks are not wired");
}

export const hooks: RenderHooks = {
  renderBase: unwired,
  renderActive: unwired,
  renderData: unwired,
  syncData: unwired,
};

export function setRenderHooks(next: RenderHooks): void {
  Object.assign(hooks, next);
}

const accessFlags = { readOnly: false, accessDenied: false };

export function isReadOnly(): boolean {
  return accessFlags.readOnly;
}

export function setReadOnly(value: boolean): void {
  accessFlags.readOnly = value;
}

export function isAccessDenied(): boolean {
  return accessFlags.accessDenied;
}

export function setAccessDenied(value: boolean): void {
  accessFlags.accessDenied = value;
}
