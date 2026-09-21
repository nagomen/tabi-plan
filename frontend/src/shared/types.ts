// 旅行ダッシュボードの共有データモデル。

export type ItemType = "sight" | "move" | "food" | "stay" | "todo" | "form";

/** 行程表の1行（1予定） */
export interface ItineraryItem {
  /** DB上の行程ID。編集画面の差分保存に使い、表示には出さない。 */
  itemId?: string;
  date: string;
  day: string;
  area?: string;
  time?: string;
  /** チップ色に対応する種別。 */
  type: ItemType | string;
  typeLabel?: string;
  title?: string;
  place?: string;
  note?: string;
  needed?: string;
  /** 緯度経度。編集中は空文字が入ることがある。 */
  lat?: number | string;
  lng?: number | string;
  mapQuery?: string;
  weather?: string;
  origin?: string;
  destination?: string;
  /** 移動予定の手段と概算所要時間。DB保存時にも独立した列として保持する。 */
  transport?: string;
  duration?: string;
  originLat?: number;
  originLng?: number;
  destinationLat?: number;
  destinationLng?: number;
  /** この予定の対象メンバー（user_id）。未指定/空 = その日の在籍メンバー全員。途中合流の個人移動などに使う。 */
  members?: string[];
  /** 公開閲覧時の匿名班キー。未指定なら全班共通の予定。 */
  publicTrackKey?: string;
  publicTrackKeys?: string[];
  /** 公開閲覧時にその日へ表示する匿名班キー。人物情報や人数は含まない。 */
  publicDayTrackKeys?: string[];
}

export interface TripInfo {
  title: string;
  dates: string;
  /** 表示文字列とは別に保持する、編集・保存用の正規化済み旅行期間。 */
  startDate?: string;
  endDate?: string;
  members: string;
  note: string;
  /** 手動設定のサムネ画像（WebP の data URL）。未設定なら目的地から自動判定/デフォルト。 */
  cover?: string;
}

export interface TripLink {
  key: string;
  label: string;
  icon?: string;
  url: string;
  caption?: string;
}

export interface SettlementTransfer {
  /** 送金元/先の user_id（表示名ではなくこちらを操作に使う） */
  fromId?: string;
  toId?: string;
  from: string;
  to: string;
  amount: number;
  amountLabel: string;
}

export interface SettlementShare {
  /** 同名メンバーを区別するための user_id。旧表示データでは未設定。 */
  userId?: string;
  name: string;
  amount: number;
  amountLabel: string;
}

export interface SettlementHistory {
  id?: string;
  date: string;
  from: string;
  to: string;
  amount: number;
  amountLabel: string;
  note?: string;
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
  id?: string;
  kind?: "expense" | "settlement";
  date: string;
  /** 支払者の user_id。表示名は payer。 */
  payerId?: string;
  payer: string;
  category: string;
  title: string;
  mode: string;
  amountLabel: string;
  convertedLabel: string;
  myShareLabel: string;
  /** 負担者の user_id。旧表示データでは未設定。 */
  targetIds?: string[];
  targetNames: string[];
  shares: SettlementShare[];
}

export interface Settlement {
  paid?: string;
  paidLabel?: string;
  expenseTotal?: string;
  /** user_id → 負担額の合計（基準通貨の最小単位）。表示名は描画側で解決する。 */
  expenseByPerson?: Record<string, number>;
  progress?: number;
  yourPaid?: string;
  yourDue?: string;
  transfers?: SettlementTransfer[];
  settlementHistory?: SettlementHistory[];
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
  /** タスク状態 "todo" | "doing" | "done"。未設定なら done から導出する（shared/checklist.ts）。 */
  status?: string;
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

/**
 * 「行きたい候補」（行程に入れる前のたたき台）。
 * メンバーが出し合い、voteIds（投票者IDの配列）を正として人気を測る。
 * 招待リンクの再共有時に votes は和集合でマージされる。
 */
export interface Candidate {
  id: string;
  title: string;
  place?: string;
  lat?: number | string;
  lng?: number | string;
  note?: string;
  /** 候補の種別（行程アイテムへ変換するときの type） */
  type?: ItemType | string;
  /** 提案者の表示名 */
  proposer?: string;
  /** 提案者のユーザーID（永続化はこちらを使う） */
  proposerId?: string;
  /** 投票したメンバーの表示名（重複なし） */
  votes: string[];
  /** 投票したメンバーのユーザーID（永続化はこちらを使う） */
  voteIds?: string[];
  /** 行程へ採用済みなら true（ボード上で薄く表示） */
  adopted?: boolean;
  createdAt?: string;
  /** 同じ時間帯で投票する候補を束ねるID。未設定は従来の「行きたい候補」。 */
  slotId?: string;
  /** 投票枠を置く日付・時刻。 */
  date?: string;
  time?: string;
  durationMinutes?: number;
  /** 投票枠の対象メンバー。空または未設定は当日の参加者全員。 */
  memberIds?: string[];
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
  /** ワークスペース参加者だけに返される候補・投票情報。 */
  candidates?: Candidate[];
}

/** 緯度経度ペア */
export interface LatLng {
  lat: number;
  lng: number;
}
