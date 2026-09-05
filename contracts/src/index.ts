/** フロントとNode APIが共有する通信DTO。実行時ロジックは置かない。 */
export interface UserRow { id: string; display_name: string }

/** 便（飛行機の移動）ごとの個人メモ。便名でひも付け、本人の行だけがAPIから返る。 */
export interface FlightNoteRow {
  plan_id: string;
  user_id: string;
  flight_no: string;
  link_url: string | null;
  booking_ref: string | null;
  seat: string | null;
  /** QRコード画像の data URL。 */
  qr_image: string | null;
}
export interface CredentialRow { user_id: string; email: string }

export interface PlanRow {
  id: string;
  slug: string;
  title: string;
  note: string | null;
  start_date: string | null;
  end_date: string | null;
  dates_label: string | null;
  cover_url: string | null;
  base_currency: string;
  source: "local" | "sample";
  visibility: "public" | "invite";
  status: "draft" | "published";
  version: number;
  open_editing: 0 | 1;
  owner_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanMemberRow {
  plan_id: string;
  user_id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "left" | "revoked";
  /** 旅行内の参加開始日（YYYY-MM-DD）。null は初日から参加。 */
  from_date: string | null;
  /** 旅行内の参加終了日（YYYY-MM-DD）。null は最終日まで参加。 */
  to_date: string | null;
}

/** 旅行内だけで先に作られ、招待後に本人アカウントへ紐付くメンバー。 */
export interface PlanMemberPlaceholderRow {
  plan_id: string;
  user_id: string;
  original_name: string;
  status: "unclaimed" | "claimed" | "removed";
  claimed_by_user_id: string | null;
  claimed_at: string | null;
}

export type ItineraryKind = "sight" | "move" | "food" | "stay" | "todo" | "form";
export interface ItineraryRow {
  id: string;
  plan_id: string;
  item_date: string | null;
  day_index: number | null;
  sort_order: number;
  kind: ItineraryKind;
  start_time: string | null;
  title: string;
  place: string | null;
  area: string | null;
  note: string | null;
  map_query: string | null;
  lat: number | null;
  lng: number | null;
  from_place: string | null;
  from_lat: number | null;
  from_lng: number | null;
  to_place: string | null;
  to_lat: number | null;
  to_lng: number | null;
  transport: string | null;
  duration_minutes: number | null;
  /** この項目の対象メンバー（user_id）。null/空 = その日の在籍メンバー全員。途中合流の個人移動などに使う。 */
  member_ids: string[] | null;
}

// ---- AI旅行相談の通信DTO -----------------------------------------------

export type AiPace = "ゆったり" | "標準" | "充実";
export type AiWalkingPreference = "少なめ" | "標準" | "気にしない";
export type AiTransportPreference = "公共交通" | "車" | "おまかせ";

export interface ItineraryAiCity {
  name: string;
  from_date: string;
  to_date: string;
  /** AI出力時だけ使用。入力では省略できる。 */
  address?: string;
  latitude?: number | null;
  longitude?: number | null;
}

export interface ItineraryAiBaseInput {
  area: string;
  start_date: string;
  end_date: string;
  note?: string;
  people?: number;
  cities?: ItineraryAiCity[];
}

export interface ItineraryAiPreferences {
  pace: AiPace;
  interests: string[];
  walking: AiWalkingPreference;
  transport: AiTransportPreference;
  extra?: string;
}

export interface ItineraryAiGenerateInput extends ItineraryAiBaseInput {
  consultation_token: string;
  selected_candidate_ids: string[];
  preferences: ItineraryAiPreferences;
  /** APIで検索済みの移動候補。未指定ならサーバー側で検索できる範囲だけ補完する。 */
  transport_options?: TransportOption[];
}

export type TransportSearchMode = "any" | "flight" | "transit" | "drive" | "walk";

export interface TransportSearchInput {
  from: string;
  to: string;
  date: string;
  time?: string;
  mode?: TransportSearchMode;
  people?: number;
}

export interface TransportOption {
  id: string;
  mode: "flight" | "transit" | "drive" | "walk" | "ferry" | "other";
  provider: "amadeus" | "google_routes" | "manual";
  from: string;
  to: string;
  departure_time: string;
  arrival_time: string;
  duration_minutes: number;
  price_label?: string;
  carrier?: string;
  service_name?: string;
  flight_number?: string;
  booking_url?: string;
  confidence: "live_offer" | "estimated" | "manual";
  note?: string;
}

export interface TransportSearchResult {
  options: TransportOption[];
  warnings: string[];
}

export interface ItineraryCandidate {
  id: string;
  name: string;
  area: string;
  category: string;
  reason: string;
  duration_minutes: number;
}

export interface ItineraryOptions {
  message: string;
  candidates: ItineraryCandidate[];
  /** 候補・都市・期間を最終生成へ安全に引き継ぐ、短時間有効な署名トークン。 */
  consultation_token: string;
}

export interface ItineraryDraftItem {
  kind: string;
  time: string;
  /** この予定を実施する登録都市。都市間移動は到着都市。 */
  city: string;
  title: string;
  place: string;
  /** 地図検索用の確認済み住所または具体的な地域表記。 */
  address: string;
  latitude: number | null;
  longitude: number | null;
  note: string;
  from_place: string;
  to_place: string;
  transport: string;
  duration_minutes: number;
  /** 都市間移動の両端。通常予定では省略される。 */
  from_address?: string;
  from_latitude?: number | null;
  from_longitude?: number | null;
  to_address?: string;
  to_latitude?: number | null;
  to_longitude?: number | null;
}

export interface ItineraryDraft {
  cities: ItineraryAiCity[];
  days: {
    date: string;
    area: string;
    items: ItineraryDraftItem[];
  }[];
  /** 選択されたが日数・移動効率の都合で組み込めなかった候補名。 */
  omitted_selected_places: string[];
}

/** 旅行詳細のAIチャットで、現在の行程と修正案をやり取りする1予定。 */
export interface ItineraryRefineItem {
  date: string;
  time: string;
  kind: ItineraryKind;
  city: string;
  title: string;
  place: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  note: string;
  from_city: string;
  from_place: string;
  from_address: string;
  from_latitude: number | null;
  from_longitude: number | null;
  to_city: string;
  to_place: string;
  to_address: string;
  to_latitude: number | null;
  to_longitude: number | null;
  transport: string;
  duration_minutes: number;
  /** この予定の対象メンバーuser_id。空/省略 = その日の参加者全員。 */
  members?: string[];
}

export interface ItineraryRefineCity {
  name: string;
  from_date: string;
  to_date: string;
}

export interface ItineraryRefineMember {
  user_id: string;
  name: string;
  from_date: string | null;
  to_date: string | null;
}

export interface ItineraryRefineMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ItineraryRefineInput {
  plan_id: string;
  start_date: string;
  end_date: string;
  active_date: string;
  instruction: string;
  history: ItineraryRefineMessage[];
  current_itinerary: ItineraryRefineItem[];
  /** 計画に登録済みの訪問地メタ。AIは依頼がない限りこの順序・期間を維持する。 */
  cities?: ItineraryRefineCity[];
  /** 参加期間つきメンバー。分岐日程のmembers判定に使う。 */
  members?: ItineraryRefineMember[];
  /** APIで検索済みの移動候補。AIは候補を優先し、候補外の便名・価格を断定しない。 */
  transport_options?: TransportOption[];
}

export interface ItineraryRefineResult {
  message: string;
  itinerary: ItineraryRefineItem[];
}

export type ExpenseCategory = "food" | "transport" | "lodging" | "sightseeing" | "communication" | "other";
export type SplitMethod = "equal_all" | "equal_selected" | "custom" | "none";
export type PaymentMethod = "card" | "cash" | "transfer" | "other";

export interface ExpenseRow {
  id: string;
  plan_id: string;
  paid_on: string | null;
  payer_user_id: string;
  category: ExpenseCategory;
  title: string;
  amount_minor: number;
  currency: string;
  fx_rate: number;
  amount_base_minor: number;
  split_method: SplitMethod;
  payment_method: PaymentMethod | null;
  note: string | null;
  receipt_url: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface ExpenseShareRow { expense_id: string; user_id: string; amount_base_minor: number }

export interface SettlementRow {
  id: string;
  plan_id: string;
  from_user_id: string;
  to_user_id: string;
  amount_base_minor: number;
  note: string | null;
  settled_at: string;
  deleted_at: string | null;
}
