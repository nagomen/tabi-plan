// API が返す行の形。フロントの shared/api.ts と同じ形を共有する意図で切り出す。
// 命名は DB 列（snake_case）に合わせる。変換層を挟まないほうが追いやすい。

export interface UserRow {
  id: string;
  display_name: string;
}

export interface CredentialRow {
  user_id: string;
  email: string;
}

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

export interface ItineraryRow {
  id: string;
  plan_id: string;
  item_date: string | null;
  day_index: number | null;
  sort_order: number;
  kind: "sight" | "move" | "food" | "stay" | "todo" | "form";
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

export interface ExpenseRow {
  id: string;
  plan_id: string;
  paid_on: string | null;
  payer_user_id: string;
  category: "food" | "transport" | "lodging" | "sightseeing" | "communication" | "other";
  title: string;
  amount_minor: number;
  currency: string;
  fx_rate: number;
  amount_base_minor: number;
  split_method: "equal_all" | "equal_selected" | "custom" | "none";
  payment_method: "card" | "cash" | "transfer" | "other" | null;
  note: string | null;
  receipt_url: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface ExpenseShareRow {
  expense_id: string;
  user_id: string;
  amount_base_minor: number;
}

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

/** 起動時に1往復で受け取る全データ。 */
export interface Bootstrap {
  users: UserRow[];
  credentials: CredentialRow[];
  plans: PlanRow[];
  members: PlanMemberRow[];
  itinerary: ItineraryRow[];
  cities: { id: string; plan_id: string; name: string; sort_order: number }[];
  links: { id: string; plan_id: string; link_key: string; label: string; url: string; caption: string | null; sort_order: number }[];
  checklist: { id: string; plan_id: string; label: string; status: "todo" | "doing" | "done"; sort_order: number }[];
  candidates: { id: string; plan_id: string; title: string; place: string | null; proposed_by_id: string | null; adopted_at: string | null }[];
  candidateVotes: { candidate_id: string; user_id: string }[];
  expenses: ExpenseRow[];
  expenseShares: ExpenseShareRow[];
  settlements: SettlementRow[];
  views: { plan_id: string; view_count: number }[];
  paymentLinks: { user_id: string; provider: string; handle: string }[];
  userSettings: { user_id: string; history_public: 0 | 1 }[];
  friendships: {
    id: string; user_low_id: string; user_high_id: string; requested_by_id: string;
    status: string; created_at: string; responded_at: string | null;
  }[];
}
