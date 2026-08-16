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
  source: "local" | "google_sheets" | "apps_script" | "sample";
  visibility: "public" | "invite";
  status: "draft" | "published";
  version: number;
  open_editing: 0 | 1;
  owner_user_id: string | null;
  external_spreadsheet_id: string | null;
  external_apps_script_url: string | null;
  external_schema: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanMemberRow {
  plan_id: string;
  user_id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "left" | "revoked";
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
  to_place: string | null;
  transport: string | null;
  duration_minutes: number | null;
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
