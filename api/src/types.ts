// API が返す行の形。フロントと共通の行型は @tabi/contracts を正とする。
// 命名は DB 列（snake_case）に合わせる。変換層を挟まないほうが追いやすい。

import type {
  CredentialRow, ExpenseRow, ExpenseShareRow, ItineraryRow, PlanMemberRow, PlanRow,
  SettlementRow, UserRow,
} from "@tabi/contracts";
export type {
  CredentialRow, ExpenseRow, ExpenseShareRow, ItineraryRow, PlanMemberRow, PlanRow,
  SettlementRow, UserRow,
} from "@tabi/contracts";

/** 起動時に1往復で受け取る全データ。 */
export interface Bootstrap {
  /**
   * サーバーがこの要求を誰として扱ったか。セッションが無い・切れている
   * ときは null。ブラウザ側は手元のログイン状態と突き合わせて、
   * 期限切れに開いた時点で気づくために使う。
   */
  viewer: { id: string } | null;
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
  pendingInvites: {
    id: string; plan_id: string; plan_slug: string; plan_title: string;
    role: "editor" | "viewer"; invited_name: string | null;
    created_at: string; expires_at: string | null;
  }[];
  friendships: {
    id: string; user_low_id: string; user_high_id: string; requested_by_id: string;
    status: string; created_at: string; responded_at: string | null;
  }[];
}
