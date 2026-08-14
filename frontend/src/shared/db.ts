// 永続化の唯一の差し替え口（旧 backend.ts の役割）。
//
// 設計:
//   - 起動時に GET /api/bootstrap で全行を1往復で取り、メモリに置く。
//   - 読み取りは同期（画面側は今までどおり同期で書ける）。
//   - 書き込みは行単位の API を非同期で投げ、手元のキャッシュも即時更新する
//     （楽観更新。失敗したら trip-db-error イベントを出す）。
//
// なぜ「表示名」ではなく id を持つか:
//   旧構造は人を表示名の文字列で参照していたため、改名で計画・費用・投票が
//   一斉に壊れ、同名の別人を区別できなかった。id を正にして、表示名は
//   users テーブルの1列（＝表示のためだけの値）に降格させる。

import { readGlobalTripConfig, DEFAULT_CONFIG, mergeConfig, normalizeTripConfig, type TripConfig } from "./config";

// ---- 行の型（API と同じ形。snake_case のまま扱う） ---------------------

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
}

export interface CityRow { id: string; plan_id: string; name: string; sort_order: number }
export interface LinkRow { id: string; plan_id: string; link_key: string; label: string; url: string; caption: string | null; sort_order: number }
export interface ChecklistRow { id: string; plan_id: string; label: string; status: "todo" | "doing" | "done"; sort_order: number }
export interface CandidateRow { id: string; plan_id: string; title: string; place: string | null; proposed_by_id: string | null; adopted_at: string | null }
export interface CandidateVoteRow { candidate_id: string; user_id: string }
export interface ViewRow { plan_id: string; view_count: number }
export interface PaymentLinkRow { user_id: string; provider: string; handle: string }
export interface UserSettingRow { user_id: string; history_public: 0 | 1 }
export interface FriendshipRow {
  id: string; user_low_id: string; user_high_id: string; requested_by_id: string;
  status: string; created_at: string; responded_at: string | null;
}

interface Snapshot {
  users: UserRow[];
  credentials: CredentialRow[];
  plans: PlanRow[];
  members: PlanMemberRow[];
  itinerary: ItineraryRow[];
  cities: CityRow[];
  links: LinkRow[];
  checklist: ChecklistRow[];
  candidates: CandidateRow[];
  candidateVotes: CandidateVoteRow[];
  expenses: ExpenseRow[];
  expenseShares: ExpenseShareRow[];
  settlements: SettlementRow[];
  views: ViewRow[];
  paymentLinks: PaymentLinkRow[];
  userSettings: UserSettingRow[];
  friendships: FriendshipRow[];
}

function emptySnapshot(): Snapshot {
  return {
    users: [], credentials: [], plans: [], members: [], itinerary: [], cities: [], links: [],
    checklist: [], candidates: [], candidateVotes: [], expenses: [], expenseShares: [],
    settlements: [], views: [], paymentLinks: [], userSettings: [], friendships: [],
  };
}

let snap: Snapshot = emptySnapshot();
let loaded = false;
let loading: Promise<void> | null = null;

// ---- 設定 ---------------------------------------------------------------

function config(): TripConfig {
  return normalizeTripConfig(
    mergeConfig(
      DEFAULT_CONFIG as unknown as Record<string, unknown>,
      readGlobalTripConfig() as Record<string, unknown>,
    ) as unknown as TripConfig,
  );
}

function api(): { base: string; token: string } | null {
  const shared = config().sharedBackend;
  if (!shared?.enabled || shared.mode !== "api") return null;
  return { base: (shared.apiBaseUrl || "").replace(/\/+$/, ""), token: shared.apiToken || "" };
}

/** API を使う構成か（未設定なら読み取り専用のサンプル動作になる）。 */
export function isEnabled(): boolean {
  return api() !== null;
}

/** bootstrap を読み終えたか。読む前に書くと実在しない行を作ってしまうので判定に使う。 */
export function isLoaded(): boolean {
  return loaded;
}

function emit(detail: Record<string, unknown>): void {
  try {
    window.dispatchEvent(new CustomEvent("trip-db-sync", { detail }));
  } catch {
    /* ignore */
  }
}

function sessionTokenForRequest(): string {
  try {
    const session = localStorage.getItem("trip-dashboard-session");
    if (session) {
      const parsed = JSON.parse(session) as { token?: string };
      if (parsed.token) return parsed.token;
    }
  } catch {
    /* ignore */
  }
  return "";
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const cfg = api();
  if (!cfg) throw new Error("共有ストアが設定されていません");
  const sessionToken = sessionTokenForRequest();
  const res = await fetch(cfg.base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      ...(sessionToken ? { "X-Travel-Session": sessionToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${method} ${path} → HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  return (await res.json()) as T;
}

export async function authSignUp(input: {
  email: string;
  password: string;
  display_name: string;
}): Promise<{ user: { id: string; display_name: string; email: string }; session: string }> {
  const result = await request<{ user: { id: string; display_name: string; email: string }; session: string }>(
    "POST", "/api/auth/signup", input,
  );
  rememberAuthenticatedUser(result.user);
  return result;
}

export async function authLogIn(input: {
  email: string;
  password: string;
}): Promise<{ user: { id: string; display_name: string; email: string }; session: string }> {
  const result = await request<{ user: { id: string; display_name: string; email: string }; session: string }>(
    "POST", "/api/auth/login", input,
  );
  rememberAuthenticatedUser(result.user);
  return result;
}

// 計画作成直後のメンバー・本文保存など、前の書き込みに依存する操作を順番に送る。
// 失敗時は bootstrap を読み直して、楽観更新した表示をサーバーの正しい状態へ戻す。
let mutationQueue: Promise<void> = Promise.resolve();
let mutationSequence = 0;
let recoveredThrough = 0;
const mutationErrors = new Map<number, unknown>();
let recovery: Promise<void> | null = null;

function recoverAfterMutations(tail: Promise<void>, sequence: number): void {
  void tail.then(() => {
    if (mutationQueue !== tail || sequence <= recoveredThrough || !mutationErrors.size) return;
    recovery = reload().catch(() => undefined).finally(() => {
      recoveredThrough = Math.max(recoveredThrough, sequence);
      recovery = null;
    });
  });
}

function send(method: string, path: string, body?: unknown): void {
  const sequence = ++mutationSequence;
  const tail = mutationQueue.then(async () => {
    try {
      await request(method, path, body);
      emit({ ok: true, path });
    } catch (error) {
      mutationErrors.set(sequence, error);
      console.error("[db]", method, path, error);
      emit({ ok: false, path, error: String(error) });
    }
  });
  mutationQueue = tail;
  recoverAfterMutations(tail, sequence);
}

/** これから始める保存が、過去の別操作のエラーを拾わないための基準点。 */
export function mutationCheckpoint(): number {
  return mutationSequence;
}

/** checkpoint より後、この時点までに登録された書き込みを待つ。 */
export async function flushMutations(checkpoint: number): Promise<void> {
  const target = mutationSequence;
  await mutationQueue;
  const failed = [...mutationErrors.entries()]
    .filter(([sequence]) => sequence > checkpoint && sequence <= target)
    .sort(([a], [b]) => a - b)[0];
  if (failed) {
    if (recovery) await recovery;
    else if (recoveredThrough < target) {
      await reload().catch(() => undefined);
      recoveredThrough = target;
    }
  }
  for (const sequence of [...mutationErrors.keys()]) {
    if (sequence <= target) mutationErrors.delete(sequence);
  }
  if (failed) throw failed[1];
}

// ---- 起動 ---------------------------------------------------------------

export async function load(): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  loading = (async () => {
    if (!api()) {
      loaded = true;
      return;
    }
    try {
      snap = await request<Snapshot>("GET", "/api/bootstrap");
      loaded = true;
      emit({ ok: true, path: "/api/bootstrap" });
    } catch (error) {
      // 取得できなくても画面は空で立ち上げる（オフライン時と同じ扱い）
      loaded = true;
      emit({ ok: false, path: "/api/bootstrap", error: String(error) });
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** サーバーから読み直す（他端末の変更を取り込む）。 */
export async function reload(): Promise<void> {
  loaded = false;
  loading = null;
  await load();
}

// ---- 同期読み取り -------------------------------------------------------

export const users = (): UserRow[] => snap.users;
export const credentials = (): CredentialRow[] => snap.credentials;
export const plans = (): PlanRow[] => snap.plans;
export const members = (): PlanMemberRow[] => snap.members;
export const itinerary = (): ItineraryRow[] => snap.itinerary;
export const cities = (): CityRow[] => snap.cities;
export const links = (): LinkRow[] => snap.links;
export const checklist = (): ChecklistRow[] => snap.checklist;
export const candidates = (): CandidateRow[] => snap.candidates;
export const candidateVotes = (): CandidateVoteRow[] => snap.candidateVotes;
export const expenses = (): ExpenseRow[] => snap.expenses;
export const expenseShares = (): ExpenseShareRow[] => snap.expenseShares;
export const settlements = (): SettlementRow[] => snap.settlements;
export const views = (): ViewRow[] => snap.views;
export const paymentLinks = (): PaymentLinkRow[] => snap.paymentLinks;
export const userSettings = (): UserSettingRow[] => snap.userSettings;
export const friendships = (): FriendshipRow[] => snap.friendships;

function rememberAuthenticatedUser(user: { id: string; display_name: string; email: string }): void {
  const existing = snap.users.find((row) => row.id === user.id);
  if (existing) existing.display_name = user.display_name;
  else snap.users.push({ id: user.id, display_name: user.display_name });
  const credential = snap.credentials.find((row) => row.user_id === user.id);
  if (credential) credential.email = user.email;
  else snap.credentials.push({ user_id: user.id, email: user.email });
}

export function userById(id: string | null | undefined): UserRow | undefined {
  return id ? snap.users.find((u) => u.id === id) : undefined;
}

/** 表示名を引く。見つからない id は空文字（欠損を「?」等で埋めない）。 */
export function nameOf(id: string | null | undefined): string {
  return userById(id)?.display_name || "";
}

const nameKey = (s: string): string => String(s || "").trim().toLowerCase();

/** 表示名から id を引く（同名は最初の1件）。 */
export function findUserByName(name: string): UserRow | undefined {
  const key = nameKey(name);
  return key ? snap.users.find((u) => nameKey(u.display_name) === key) : undefined;
}

export function planBySlug(slug: string): PlanRow | undefined {
  return snap.plans.find((p) => p.slug === slug);
}

export function planById(id: string): PlanRow | undefined {
  return snap.plans.find((p) => p.id === id);
}

// ---- 書き込み（楽観更新 + 行単位 API） ----------------------------------

let localSeq = 0;
function localId(prefix: string): string {
  localSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${localSeq.toString(36).padStart(3, "0")}`;
}

/**
 * 表示名からユーザーを確保する。まだ居なければ作る
 * （招待前でも実体を持たせる方針。画面側は名前を入力するだけでよい）。
 */
export async function ensureUser(displayName: string): Promise<UserRow> {
  const existing = findUserByName(displayName);
  if (existing) return existing;
  const created = await request<UserRow>("POST", "/api/users", {
    display_name: displayName,
    ensure: true,
  });
  if (!snap.users.some((u) => u.id === created.id)) snap.users.push(created);
  return created;
}

/** 新規登録用。同名ユーザーがいても、別人として新しい users 行を作る。 */
export async function createUser(displayName: string): Promise<UserRow> {
  const created = await request<UserRow>("POST", "/api/users", { display_name: displayName });
  if (!snap.users.some((u) => u.id === created.id)) snap.users.push(created);
  return created;
}

export async function searchUsers(query: string): Promise<{ id: string; display_name: string; email: string }[]> {
  const res = await request<{ users: { id: string; display_name: string; email: string }[] }>(
    "POST", "/api/users/search", { query },
  );
  for (const user of res.users) {
    if (!snap.users.some((row) => row.id === user.id)) snap.users.push({ id: user.id, display_name: user.display_name });
    if (user.email && !snap.credentials.some((row) => row.user_id === user.id)) {
      snap.credentials.push({ user_id: user.id, email: user.email });
    }
  }
  return res.users;
}

/**
 * 同期版。id をこちら側で決めてキャッシュへ入れ、登録は非同期で追いかける。
 * 呼び出し側（計画の保存など）を同期のまま保つために使う。
 * id を渡して作るので、サーバー側と食い違うことはない。
 */
export function ensureUserLocal(displayName: string): UserRow {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new Error("表示名が空です");
  const existing = findUserByName(name);
  if (existing) return existing;
  const row: UserRow = { id: localId("usr"), display_name: name };
  snap.users.push(row);
  send("POST", "/api/users", { id: row.id, display_name: name });
  return row;
}

export function renameUser(userId: string, displayName: string): void {
  const user = userById(userId);
  if (user) user.display_name = displayName;
  send("PATCH", `/api/users/${encodeURIComponent(userId)}`, { display_name: displayName });
}

export function setPaymentLink(userId: string, handle: string): void {
  const row = snap.paymentLinks.find((p) => p.user_id === userId && p.provider === "paypay");
  if (handle) {
    if (row) row.handle = handle;
    else snap.paymentLinks.push({ user_id: userId, provider: "paypay", handle });
  } else if (row) {
    snap.paymentLinks = snap.paymentLinks.filter((p) => p !== row);
  }
  send("PUT", `/api/users/${encodeURIComponent(userId)}/payment-link`, { handle });
}

export function setHistoryPublic(userId: string, isPublic: boolean): void {
  const row = snap.userSettings.find((s) => s.user_id === userId);
  if (row) row.history_public = isPublic ? 1 : 0;
  else snap.userSettings.push({ user_id: userId, history_public: isPublic ? 1 : 0 });
  send("PUT", `/api/users/${encodeURIComponent(userId)}/settings`, { history_public: isPublic });
}

export async function createPlan(input: Partial<PlanRow>): Promise<PlanRow> {
  const res = await request<{ id: string }>("POST", "/api/plans", input);
  const row: PlanRow = {
    id: res.id, slug: input.slug || res.id, title: input.title || "無題の旅行", note: input.note ?? null,
    start_date: input.start_date ?? null, end_date: input.end_date ?? null, dates_label: input.dates_label ?? null,
    cover_url: input.cover_url ?? null, base_currency: input.base_currency || "JPY",
    source: input.source || "local", visibility: input.visibility || "public",
    status: input.status || "draft", open_editing: input.open_editing || 0,
    owner_user_id: input.owner_user_id ?? null,
    external_spreadsheet_id: input.external_spreadsheet_id ?? null,
    external_apps_script_url: input.external_apps_script_url ?? null,
    external_schema: input.external_schema ?? null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  snap.plans.push(row);
  return row;
}

export async function createInvite(planId: string, input: { invited_name?: string; role?: "editor" | "viewer" }): Promise<{ token: string }> {
  return request<{ token: string }>("POST", `/api/plans/${encodeURIComponent(planId)}/invites`, {
    invited_name: input.invited_name || "",
    role: input.role || "editor",
  });
}

export async function acceptInvite(token: string): Promise<{ planSlug: string }> {
  const result = await request<{ planSlug: string }>("POST", "/api/invites/accept", { token });
  await reload();
  return result;
}

export async function leavePlan(planId: string): Promise<void> {
  await request("DELETE", `/api/plans/${encodeURIComponent(planId)}/members/me`);
  await reload();
}

export async function transferPlanOwnership(planId: string, userId: string): Promise<void> {
  await request("POST", `/api/plans/${encodeURIComponent(planId)}/owner-transfer`, { user_id: userId });
  await reload();
}

/**
 * 同期版の計画作成。id をこちら側で決めてキャッシュへ入れ、登録は非同期で追いかける。
 * 計画の保存（plan-editor など）を同期のまま保つために使う。
 */
export function createPlanLocal(input: Partial<PlanRow> & { slug: string }): PlanRow {
  const row: PlanRow = {
    id: localId("pln"), slug: input.slug, title: input.title || "無題の旅行", note: input.note ?? null,
    start_date: input.start_date ?? null, end_date: input.end_date ?? null, dates_label: input.dates_label ?? null,
    cover_url: input.cover_url ?? null, base_currency: input.base_currency || "JPY",
    source: input.source || "local", visibility: input.visibility || "public",
    status: input.status || "draft", open_editing: input.open_editing || 0,
    owner_user_id: input.owner_user_id ?? null,
    external_spreadsheet_id: input.external_spreadsheet_id ?? null,
    external_apps_script_url: input.external_apps_script_url ?? null,
    external_schema: input.external_schema ?? null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  snap.plans.push(row);
  send("POST", "/api/plans", { ...row });
  return row;
}

export function updatePlan(planId: string, patch: Partial<PlanRow>): void {
  const row = planById(planId);
  if (row) Object.assign(row, patch);
  send("PATCH", `/api/plans/${encodeURIComponent(planId)}`, patch);
}

export async function deletePlan(planId: string): Promise<void> {
  await request("DELETE", `/api/plans/${encodeURIComponent(planId)}`);
  await reload();
}

export function replaceMembers(planId: string, list: { user_id: string; role?: PlanMemberRow["role"] }[]): void {
  snap.members = snap.members.filter((m) => m.plan_id !== planId).concat(
    list.filter((m) => m.user_id).map((m) => ({
      plan_id: planId, user_id: m.user_id, role: m.role || "editor", status: "active" as const,
    })),
  );
  send("PUT", `/api/plans/${encodeURIComponent(planId)}/members`, { members: list });
}

export interface PlanContent {
  itinerary?: Omit<ItineraryRow, "id" | "plan_id" | "sort_order">[];
  cities?: { name: string }[];
  links?: Omit<LinkRow, "id" | "plan_id" | "sort_order">[];
  checklist?: { label: string; status?: ChecklistRow["status"] }[];
  candidates?: { id?: string; title: string; place?: string | null; proposed_by_id?: string | null; adopted?: boolean; votes?: string[] }[];
}

/** 行程・都市・リンク・チェックリスト・候補を一括置換（エディタの保存に対応）。 */
export function replacePlanContent(planId: string, content: PlanContent): void {
  if (content.itinerary) {
    snap.itinerary = snap.itinerary.filter((i) => i.plan_id !== planId).concat(
      content.itinerary.map((it, i) => ({ ...it, id: localId("itm"), plan_id: planId, sort_order: i })),
    );
  }
  if (content.cities) {
    snap.cities = snap.cities.filter((c) => c.plan_id !== planId).concat(
      content.cities.map((c, i) => ({ id: localId("cty"), plan_id: planId, name: c.name, sort_order: i })),
    );
  }
  if (content.links) {
    snap.links = snap.links.filter((l) => l.plan_id !== planId).concat(
      content.links.map((l, i) => ({ ...l, id: localId("lnk"), plan_id: planId, sort_order: i })),
    );
  }
  if (content.checklist) {
    snap.checklist = snap.checklist.filter((c) => c.plan_id !== planId).concat(
      content.checklist.map((c, i) => ({
        id: localId("chk"), plan_id: planId, label: c.label, status: c.status || "todo", sort_order: i,
      })),
    );
  }
  if (content.candidates) {
    const ids = new Set(snap.candidates.filter((c) => c.plan_id === planId).map((c) => c.id));
    snap.candidateVotes = snap.candidateVotes.filter((v) => !ids.has(v.candidate_id));
    snap.candidates = snap.candidates.filter((c) => c.plan_id !== planId);
    for (const c of content.candidates) {
      const id = c.id || localId("cnd");
      snap.candidates.push({
        id, plan_id: planId, title: c.title, place: c.place ?? null,
        proposed_by_id: c.proposed_by_id ?? null, adopted_at: c.adopted ? new Date().toISOString() : null,
      });
      for (const uid of new Set(c.votes || [])) snap.candidateVotes.push({ candidate_id: id, user_id: uid });
    }
  }
  send("PUT", `/api/plans/${encodeURIComponent(planId)}/content`, content);
}

export function countView(planId: string): void {
  const row = snap.views.find((v) => v.plan_id === planId);
  if (row) row.view_count += 1;
  else snap.views.push({ plan_id: planId, view_count: 1 });
  send("POST", `/api/plans/${encodeURIComponent(planId)}/views`);
}

export interface ExpenseInput {
  paid_on?: string | null;
  payer_user_id: string;
  category?: ExpenseCategory;
  title?: string;
  amount_minor: number;
  currency?: string;
  fx_rate?: number;
  split_method?: SplitMethod;
  payment_method?: PaymentMethod | null;
  note?: string | null;
  receipt_url?: string | null;
  shares: { user_id: string; amount_base_minor: number }[];
}

/** 費用を1件追加する。行の INSERT なので、他端末と同時に追加しても消えない。 */
export async function addExpense(planId: string, input: ExpenseInput): Promise<ExpenseRow> {
  const res = await request<{ id: string }>("POST", `/api/plans/${encodeURIComponent(planId)}/expenses`, input);
  const rate = input.fx_rate && input.fx_rate > 0 ? input.fx_rate : 1;
  const row: ExpenseRow = {
    id: res.id, plan_id: planId, paid_on: input.paid_on ?? null, payer_user_id: input.payer_user_id,
    category: input.category || "other", title: input.title || "",
    amount_minor: Math.round(input.amount_minor), currency: (input.currency || "JPY").toUpperCase(),
    fx_rate: rate, amount_base_minor: Math.round(input.amount_minor * rate),
    split_method: input.split_method || "equal_all", payment_method: input.payment_method ?? null,
    note: input.note ?? null, receipt_url: input.receipt_url ?? null,
    created_at: new Date().toISOString(), deleted_at: null,
  };
  snap.expenses.push(row);
  for (const s of input.shares) {
    if (s.amount_base_minor > 0) snap.expenseShares.push({ expense_id: res.id, ...s });
  }
  return row;
}

export async function updateExpense(expenseId: string, input: ExpenseInput): Promise<void> {
  await request("PATCH", `/api/expenses/${encodeURIComponent(expenseId)}`, input);
  const row = snap.expenses.find((e) => e.id === expenseId);
  const rate = input.fx_rate && input.fx_rate > 0 ? input.fx_rate : 1;
  if (row) {
    Object.assign(row, {
      paid_on: input.paid_on ?? null, payer_user_id: input.payer_user_id,
      category: input.category || "other", title: input.title || "",
      amount_minor: Math.round(input.amount_minor), currency: (input.currency || "JPY").toUpperCase(),
      fx_rate: rate, amount_base_minor: Math.round(input.amount_minor * rate),
      split_method: input.split_method || "equal_all", payment_method: input.payment_method ?? null,
      note: input.note ?? null, receipt_url: input.receipt_url ?? null,
    });
  }
  snap.expenseShares = snap.expenseShares.filter((s) => s.expense_id !== expenseId);
  for (const s of input.shares) {
    if (s.amount_base_minor > 0) snap.expenseShares.push({ expense_id: expenseId, ...s });
  }
}

/** 論理削除。元に戻せるよう、消した行と負担を返す。 */
export function removeExpense(expenseId: string): { row: ExpenseRow | undefined; shares: ExpenseShareRow[] } {
  const row = snap.expenses.find((e) => e.id === expenseId);
  const shares = snap.expenseShares.filter((s) => s.expense_id === expenseId);
  if (row) row.deleted_at = new Date().toISOString();
  send("DELETE", `/api/expenses/${encodeURIComponent(expenseId)}`);
  return { row, shares };
}

export function restoreExpense(row: ExpenseRow, shares: ExpenseShareRow[]): void {
  row.deleted_at = null;
  if (!snap.expenses.some((e) => e.id === row.id)) snap.expenses.push(row);
  for (const s of shares) {
    if (!snap.expenseShares.some((x) => x.expense_id === s.expense_id && x.user_id === s.user_id)) {
      snap.expenseShares.push(s);
    }
  }
  send("POST", `/api/expenses/${encodeURIComponent(row.id)}/restore`);
}

export async function addSettlement(planId: string, input: {
  from_user_id: string; to_user_id: string; amount_base_minor: number; note?: string | null;
}): Promise<void> {
  const res = await request<{ id: string }>("POST", `/api/plans/${encodeURIComponent(planId)}/settlements`, input);
  snap.settlements.push({
    id: res.id, plan_id: planId, from_user_id: input.from_user_id, to_user_id: input.to_user_id,
    amount_base_minor: input.amount_base_minor, note: input.note ?? null,
    settled_at: new Date().toISOString(),
  });
}

export async function saveFriendship(input: { a: string; b: string; requested_by_id: string; status?: string }): Promise<void> {
  const res = await request<{ id: string }>("POST", "/api/friendships", input);
  const [low, high] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  const row = snap.friendships.find((f) => f.user_low_id === low && f.user_high_id === high);
  if (row) {
    row.status = input.status || "pending";
    row.responded_at = new Date().toISOString();
  } else {
    snap.friendships.push({
      id: res.id, user_low_id: low, user_high_id: high, requested_by_id: input.requested_by_id,
      status: input.status || "pending", created_at: new Date().toISOString(), responded_at: null,
    });
  }
}
