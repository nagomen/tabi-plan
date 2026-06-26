// 旅行ダッシュボードの共有データモデル。
// Google Sheets / Apps Script / ローカルプランのいずれの取得元でも、
// この TripData 形状に正規化してから各画面が描画する。

export type ItemType = "sight" | "move" | "food" | "stay" | "todo" | "form";

/** 行程表の1行（1予定） */
export interface ItineraryItem {
  date: string;
  day: string;
  area?: string;
  time?: string;
  /** チップ色に対応する種別。Sheets からは任意文字列が来ることがある */
  type: ItemType | string;
  typeLabel?: string;
  title?: string;
  place?: string;
  note?: string;
  needed?: string;
  /** 緯度経度。Sheets からは文字列、ローカル作成では number か "" が入る */
  lat?: number | string;
  lng?: number | string;
  mapQuery?: string;
  weather?: string;
  origin?: string;
  destination?: string;
  originLat?: number;
  originLng?: number;
  destinationLat?: number;
  destinationLng?: number;
  /** Apps Script 行程編集で使う表示上書き情報（任意） */
  rowNumber?: number | string;
  edit?: ItineraryEdit;
}

export interface ItineraryEdit {
  visible?: boolean;
  displayTime?: string;
  displayTitle?: string;
  displayPlace?: string;
  displayNote?: string;
  needed?: string;
  mapQuery?: string;
  weather?: string;
  rawMemo?: string;
  origin?: string;
  destination?: string;
  transport?: string;
  duration?: string;
  status?: string;
  certainty?: string;
  purpose?: string;
}

export interface TripInfo {
  title: string;
  dates: string;
  members: string;
  note: string;
}

export interface TripLink {
  key: string;
  label: string;
  icon?: string;
  url: string;
  caption?: string;
}

export interface SettlementTransfer {
  from: string;
  to: string;
  amount: number;
  amountLabel: string;
}

export interface SettlementShare {
  name: string;
  amount: number;
  amountLabel: string;
}

export interface RateDetail {
  date: string;
  payer: string;
  title: string;
  currency: string;
  amount: string;
  rateDate: string;
  rate: number;
  converted: string;
}

export interface ExpenseDetail {
  date: string;
  payer: string;
  category: string;
  title: string;
  mode: string;
  amountLabel: string;
  convertedLabel: string;
  myShareLabel: string;
  targetNames: string[];
  shares: SettlementShare[];
}

export interface Settlement {
  paid?: string;
  paidLabel?: string;
  expenseTotal?: string;
  expenseByPerson?: Record<string, number>;
  progress?: number;
  yourPaid?: string;
  yourDue?: string;
  transfers?: SettlementTransfer[];
  rateDetails?: RateDetail[];
  expenseDetails?: ExpenseDetail[];
  rateWarnings?: string[];
  baseCurrency?: string;
  photoTitle?: string;
  photoMeta?: string;
  title?: string;
  dates?: string;
  members?: string;
  note?: string;
}

export interface ChecklistItem {
  label: string;
  done: boolean | string;
}

export interface LocalInfoItem {
  country: string;
  currencyCode?: string;
  currencyName?: string;
  approxRate?: string;
  rateUpdatedAt?: string;
  feeFreeAtm?: string;
  atmBest?: string;
  atmFee?: string;
  atmNote?: string;
  rideBest?: string;
  rideAlt?: string;
  paymentNote?: string;
  source?: string;
  order?: number;
}

/** ルート上の滞在都市（大まかな場所＋滞在期間） */
export interface RouteCity {
  name: string;
  fromDate: string;
  toDate: string;
  lat?: number | string;
  lng?: number | string;
}

/** 各画面が描画する正規化済みデータ */
export interface TripData {
  trip: TripInfo;
  links: TripLink[];
  settlement: Settlement;
  checklist: ChecklistItem[];
  localInfo: LocalInfoItem[];
  itinerary: ItineraryItem[];
  /** 滞在都市（任意）。無ければダッシュボードは行程の area から推定する */
  cities?: RouteCity[];
}

/** Sheets の gviz から得られる1行（ヘッダー名 -> セル値） */
export type SheetRow = Record<string, string>;

/** 緯度経度ペア */
export interface LatLng {
  lat: number;
  lng: number;
}
