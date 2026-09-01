/** フロントとNode APIが共有する通信DTO。実行時ロジックは置かない。 */
export interface UserRow { id: string; display_name: string }
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
