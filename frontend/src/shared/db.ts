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

import { resolvedTripConfig } from "./config";
import type {
  CredentialRow, ExpenseCategory, ExpenseRow, ExpenseShareRow, ItineraryRow,
  ItineraryAiBaseInput, ItineraryAiGenerateInput, ItineraryDraft, ItineraryOptions,
  PaymentMethod, PlanMemberPlaceholderRow, PlanMemberRow, PlanRow, SettlementRow, SplitMethod, UserRow,
} from "@tabi/contracts";
export type {
  CredentialRow, ExpenseCategory, ExpenseRow, ExpenseShareRow, ItineraryKind, ItineraryRow,
  ItineraryAiBaseInput, ItineraryAiGenerateInput, ItineraryAiPreferences, ItineraryDraft, ItineraryOptions,
  PaymentMethod, PlanMemberPlaceholderRow, PlanMemberRow, PlanRow, SettlementRow, SplitMethod, UserRow,
} from "@tabi/contracts";

// ---- 行の型（API と同じ形。snake_case のまま扱う） ---------------------

export interface CityRow { id: string; plan_id: string; name: string; sort_order: number }
export interface LinkRow { id: string; plan_id: string; link_key: string; label: string; url: string; caption: string | null; sort_order: number }
export interface ChecklistRow { id: string; plan_id: string; label: string; status: "todo" | "doing" | "done"; sort_order: number }
export interface CandidateRow { id: string; plan_id: string; title: string; place: string | null; proposed_by_id: string | null; adopted_at: string | null }
export interface CandidateVoteRow { candidate_id: string; user_id: string }
export interface ViewRow { plan_id: string; view_count: number }
export interface PaymentLinkRow { user_id: string; provider: string; handle: string }
export interface UserSettingRow { user_id: string; history_public: 0 | 1 }
export interface PendingInviteRow {
  id: string; plan_id: string; plan_slug: string; plan_title: string;
  role: "editor" | "viewer"; invited_name: string | null;
  created_at: string; expires_at: string | null;
}
export interface InviteInspection {
  planSlug: string;
  planTitle: string;
  invitedName: string;
  requiresMemberSelection: boolean;
  memberOptions: { userId: string; displayName: string }[];
}
export interface FriendshipRow {
  id: string; user_low_id: string; user_high_id: string; requested_by_id: string;
  status: string; created_at: string; responded_at: string | null;
}

interface Snapshot {
  /** サーバーがこの要求を誰として扱ったか。セッション切れなら null。 */
  viewer?: { id: string } | null;
  /** 自分に紐付いている外部ログイン（いまは LINE）。 */
  identities?: { provider: string; display_name: string | null }[];
  users: UserRow[];
  credentials: CredentialRow[];
  plans: PlanRow[];
  members: PlanMemberRow[];
  memberPlaceholders: PlanMemberPlaceholderRow[];
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
  pendingInvites: PendingInviteRow[];
  friendships: FriendshipRow[];
}

function emptySnapshot(): Snapshot {
  return {
    users: [], credentials: [], plans: [], members: [], memberPlaceholders: [], itinerary: [], cities: [], links: [],
    checklist: [], candidates: [], candidateVotes: [], expenses: [], expenseShares: [],
    settlements: [], views: [], paymentLinks: [], userSettings: [], pendingInvites: [], friendships: [],
    viewer: null, identities: [],
  };
}

let snap: Snapshot = emptySnapshot();
let loaded = false;
let loading: Promise<void> | null = null;
const SESSION_STORAGE_KEY = "trip-dashboard-session";

// ---- 設定 ---------------------------------------------------------------

function api(): { base: string; token: string } | null {
  const shared = resolvedTripConfig().sharedBackend;
  if (!shared?.enabled || shared.mode !== "api") return null;
  return { base: (shared.apiBaseUrl || "").replace(/\/+$/, ""), token: shared.apiToken || "" };
}

/** API を使う構成か（未設定なら読み取り専用のサンプル動作になる）。 */
export function isEnabled(): boolean {
  return api() !== null;
}

// ---- LINE の手続きをこの端末に結び付ける印 -------------------------------
//
// 印が無いと、攻撃者が自分で完走した戻り先 URL（#line_session=…）を他人に
// 踏ませるだけで、その人を攻撃者のアカウントにログインさせられる。
// 開始時にこの端末へ印を置き、戻ってきた印と一致しなければ受け取らない。

const LINE_NONCE_KEY = "trip-line-nonce";
const LINE_RETURN_HASH_KEY = "trip-line-return-hash";
const LINE_NONCE_TTL_MS = 10 * 60 * 1000;

function issueLineNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  try {
    localStorage.setItem(LINE_NONCE_KEY, JSON.stringify({ value, expiresAt: Date.now() + LINE_NONCE_TTL_MS }));
  } catch {
    /* 保存できない端末では照合できないが、開始自体は妨げない */
  }
  return value;
}

/** 印を取り出して消す（一度しか使えないようにする）。 */
function takeLineNonce(): string {
  try {
    const raw = localStorage.getItem(LINE_NONCE_KEY);
    localStorage.removeItem(LINE_NONCE_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { value?: string; expiresAt?: number };
    if (!parsed.value || !parsed.expiresAt || parsed.expiresAt < Date.now()) return "";
    return parsed.value;
  } catch {
    return "";
  }
}

/**
 * LINEへ招待トークンを渡さず、同じブラウザ内だけで招待fragmentを一時保持する。
 * OAuthのstateやURLクエリへ入れないので、LINE・nginx・アクセスログには送られない。
 */
function rememberLineReturnHash(rawUrl: string, nonce: string): void {
  try {
    const url = new URL(rawUrl, location.href);
    if (url.origin !== location.origin) throw new Error("foreign origin");
    const input = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
    const join = String(input.get("join") || "").slice(0, 8192);
    if (!join) {
      localStorage.removeItem(LINE_RETURN_HASH_KEY);
      return;
    }
    const output = new URLSearchParams({ join });
    const member = String(input.get("member") || "");
    if (/^[\w-]{1,32}$/.test(member)) output.set("member", member);
    localStorage.setItem(LINE_RETURN_HASH_KEY, JSON.stringify({
      value: output.toString(), nonce, expiresAt: Date.now() + 10 * 60 * 1000,
    }));
  } catch {
    try { localStorage.removeItem(LINE_RETURN_HASH_KEY); } catch { /* ignore */ }
  }
}

function takeLineReturnHash(nonce: string): string {
  try {
    const raw = localStorage.getItem(LINE_RETURN_HASH_KEY);
    localStorage.removeItem(LINE_RETURN_HASH_KEY);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as { value?: string; nonce?: string; expiresAt?: number };
    if (!parsed.value || parsed.nonce !== nonce || !parsed.expiresAt || parsed.expiresAt < Date.now()) return "";
    return parsed.value;
  } catch {
    return "";
  }
}

/** LINE ログインの導線を作るための API のベース URL（未設定なら空）。 */
export function apiBaseUrl(): string {
  return api()?.base || "";
}

/** bootstrap を読み終えたか。読む前に書くと実在しない行を作ってしまうので判定に使う。 */
/**
 * LINE から戻った直後の取り込み結果。
 *
 * 取り込みはどの画面に戻ってきても効くよう、このモジュールの読み込み時に
 * 一度だけ行う。ログイン画面だけで拾っていたため、戻り先が plans.html や
 * mypage.html だとトークンを保存できず、ログイン状態にならなかった。
 * 利用者 id は bootstrap の viewer から埋まる（syncIdentity）。
 */
const urlSession = readSessionFromUrl();

/** 直前の取り込み結果（画面側の遷移判断に使う）。 */
export function adoptSessionFromUrl(): { ok: boolean; error: string } {
  return urlSession;
}

/**
 * LINE の認可 URL をサーバーに作らせる。ログイン中に呼べば紐付けになる。
 *
 * URL を GET で組ませるとセッショントークンがクエリに乗り、nginx の
 * アクセスログに平文で残ってしまう。ここは POST でヘッダに載せて渡す。
 */
export async function lineAuthorizeUrl(returnTo: string): Promise<string> {
  if (!api()) return "";
  const nonce = issueLineNonce();
  rememberLineReturnHash(returnTo, nonce);
  const result = await request<{ url?: string }>("POST", "/api/auth/line/authorize-url", {
    return_to: returnTo,
    nonce,
  });
  return result.url || "";
}

/**
 * LINE ログインから戻ってきたときのセッションを取り込む。
 *
 * サーバーは #line_session=... で返す（fragment はサーバーへ送られないので
 * アクセスログに残らない）。取り込んだら URL から消す。
 * 表示名などは bootstrap の viewer から後で埋まる。
 */
function readSessionFromUrl(): { ok: boolean; error: string } {
  let hash = "";
  try {
    hash = location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
  } catch {
    return { ok: false, error: "" };
  }
  if (!hash) return { ok: false, error: "" };
  const params = new URLSearchParams(hash);
  const token = params.get("line_session") || "";
  const nonce = params.get("line_nonce") || "";
  const error = params.get("line_error") || "";
  if (!token && !error) return { ok: false, error: "" };
  params.delete("line_session");
  params.delete("line_nonce");
  params.delete("line_error");
  try {
    const rest = params.toString();
    history.replaceState(null, "", location.pathname + location.search + (rest ? "#" + rest : ""));
  } catch {
    /* ignore */
  }
  if (!token) return { ok: false, error };
  // この端末が始めた手続きでなければ受け取らない（セッション固定を防ぐ）
  const expected = takeLineNonce();
  if (!nonce || !expected || nonce !== expected) {
    return {
      ok: false,
      error: "この端末で開始したログインではないため、受け取りませんでした。もう一度ログインしてください。",
    };
  }
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ userId: "", email: "", name: "", token }));
  } catch {
    return { ok: false, error: "この端末にログイン情報を保存できませんでした" };
  }
  const returnHash = takeLineReturnHash(nonce);
  if (returnHash) {
    try { history.replaceState(null, "", location.pathname + location.search + "#" + returnHash); } catch { /* ignore */ }
  }
  return { ok: true, error: "" };
}

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
    const session = localStorage.getItem(SESSION_STORAGE_KEY);
    if (session) {
      const parsed = JSON.parse(session) as { token?: string };
      if (parsed.token) return parsed.token;
    }
  } catch {
    /* ignore */
  }
  return "";
}

function expireBrowserSession(): void {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* localStorage が使えない環境 */
  }
  try {
    window.dispatchEvent(new CustomEvent("trip-session-expired"));
  } catch {
    /* ignore */
  }
}

function responseErrorCode(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "";
  } catch {
    return "";
  }
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
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
    const code = responseErrorCode(text);
    if (res.status === 401 && code === "session_required") {
      expireBrowserSession();
      throw new Error("ログインセッションの期限が切れました。再ログインしてください。");
    }
    let message = "リクエストに失敗しました";
    let retryAfter = 0;
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown; retry_after?: unknown };
      if (typeof parsed.message === "string" && parsed.message) message = parsed.message;
      else if (typeof parsed.error === "string" && parsed.error) {
        message = parsed.error === "forbidden"
          ? "この計画を保存する権限がありません"
          : parsed.error === "ER_DUP_ENTRY"
            ? "同じURLの計画が既に存在します。別のURLで再試行してください"
            : parsed.error === "internal error"
              ? "サーバーで保存処理に失敗しました"
              : parsed.error;
      }
      retryAfter = Math.max(0, Number(parsed.retry_after) || 0);
    } catch { /* JSONでない上流情報は画面へ出さない */ }
    throw new ApiRequestError(message, res.status, code || "request_failed", retryAfter);
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

export async function authLogOut(): Promise<void> {
  await request("POST", "/api/auth/logout", {});
}

/** パスワードを変える。成功すると他の端末のセッションは切れる。 */
export async function changePassword(input: {
  current_password: string;
  new_password: string;
}): Promise<{ revoked: number }> {
  const result = await request<{ revoked?: number }>("POST", "/api/auth/password", input);
  return { revoked: Number(result.revoked) || 0 };
}

/**
 * LINE だけで作ったアカウントに、メールアドレスとパスワードを足す。
 * LINE を使えなくなったときの入り口になる。
 */
export async function addCredentials(input: { email: string; password: string }): Promise<void> {
  const result = await request<{ email?: string }>("POST", "/api/auth/credentials", input);
  if (result.email) snap.credentials = [...snap.credentials, { user_id: snap.viewer?.id || "", email: result.email }];
}

/** 他の端末のログインを切る（端末を失くしたとき用）。 */
export async function revokeOtherSessions(): Promise<number> {
  const result = await request<{ revoked?: number }>("POST", "/api/auth/sessions/revoke-others", {});
  return Number(result.revoked) || 0;
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
      scheduleCacheWrite();
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

/**
 * 直前の bootstrap を端末に残しておく置き場。
 *
 * 以前は全ページが `db.load()`（＝API を1往復）を待ってから画面を組み立てていた。
 * 転送量は gzip で 13KB ほどなので問題は往復のレイテンシで、実測では
 * 4G 相当で中身が出るまで約 1.7 秒、電波が悪いと約 4.2 秒かかっていた。
 * これがページ遷移のたびに起きるので「たまにカクつく」原因になっていた。
 *
 * そこで前回の結果で即座に立ち上げ、裏で取り直す（stale-while-revalidate）。
 * 取り直しが終わったら trip-db-sync（refreshed: true）を投げるので、
 * 描き直したい画面はそれを拾う。
 */
const CACHE_PREFIX = "trip-db-bootstrap:";

function cacheKey(): string {
  // セッションごとに分ける。アカウントを切り替えたときに前の人の
  // データが残らないようにするため。
  const token = sessionTokenForRequest();
  return CACHE_PREFIX + (token ? token.slice(0, 24) : "anon");
}

function readCache(): Snapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    // 形が変わった古いキャッシュは捨てる
    if (!parsed || !Array.isArray(parsed.plans) || !Array.isArray(parsed.users)) return null;
    // version 導入前のキャッシュは競合検知に使えないので破棄する。
    if (parsed.plans.some((plan) => !plan || typeof plan.version !== "number")) return null;
    return { ...emptySnapshot(), ...parsed } as Snapshot;
  } catch {
    return null;
  }
}

function writeCache(value: Snapshot): void {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(value));
  } catch {
    // 容量超過などは黙って諦める（次回は素直に取りに行くだけ）
  }
}

/** 楽観更新した内容も残したいので、書き込みが落ち着いたら控えを取り直す。 */
let cacheTimer = 0;
function scheduleCacheWrite(): void {
  window.clearTimeout(cacheTimer);
  cacheTimer = window.setTimeout(() => writeCache(snap), 400);
}

/**
 * サーバーが認識した利用者と、手元のログイン状態を突き合わせる。
 *
 * bootstrap はセッションが無くても公開ぶんを 200 で返すので、
 * トークンだけ切れている状態は「保存しようとするまで気づけない」
 * 状態だった。読み込んだ時点で気づけるよう、ここで判定する。
 */
const IDENTITY_STORAGE_KEY = "trip-dashboard-identity";

/**
 * サーバーが認めた利用者に、手元の「自分」を合わせる。
 *
 * この2つがずれていると、作成者を別人にした行を作ってしまい、
 * 保存が 403（この計画を保存する権限がありません）になる。
 * 公開計画のコピーで実際にこれが起きていた。
 * identity.ts は db.ts を読むので、ここでは保存先へ直接書く。
 */
function syncIdentity(userId: string): void {
  try {
    const raw = localStorage.getItem(IDENTITY_STORAGE_KEY);
    const current = raw ? (JSON.parse(raw) as { userId?: string }).userId || "" : "";
    if (current === userId) return;
    localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify({ userId }));
  } catch {
    /* localStorage が使えない環境 */
  }
  // セッションが持つ利用者もそろえる（画面の「ログイン中」表示がずれないように）
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return;
    const session = JSON.parse(raw) as { userId?: string };
    if (session.userId === userId) return;
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ ...session, userId }));
  } catch {
    /* ignore */
  }
}

function checkViewer(fresh: Snapshot): void {
  // viewer を返さない古い API では判定できない。ここで期限切れ扱いにすると、
  // API を入れ替える前にフロントだけ配ったときに全員がログアウトされてしまう。
  if (!("viewer" in fresh)) return;
  if (!sessionTokenForRequest()) return; // そもそも未ログインなら何もしない
  const viewerId = fresh.viewer && fresh.viewer.id ? fresh.viewer.id : "";
  if (viewerId) {
    syncIdentity(viewerId);
    return;
  }
  // 手元にはトークンがあるのにサーバーは誰とも認識していない＝期限切れ
  expireBrowserSession();
}

/**
 * 画面を描き直すべき変化があったかだけを見る指紋。
 *
 * 全体を JSON.stringify して比べていたが、閲覧数のように「誰かが見た」
 * だけで動く値まで差分になり、そのたびに画面を作り直していた。
 * 表示に関わる行の数と、最後の更新時刻だけを見る。
 */
function renderFingerprint(value: Snapshot): string {
  const counts = [
    value.plans, value.members, value.itinerary, value.cities, value.links,
    value.checklist, value.candidates, value.candidateVotes, value.expenses,
    value.expenseShares, value.settlements, value.users, value.paymentLinks,
    value.userSettings, value.friendships, value.pendingInvites,
  ].map((rows) => (Array.isArray(rows) ? rows.length : 0)).join(",");
  let latest = "";
  for (const plan of value.plans || []) {
    const at = plan.updated_at || "";
    if (at > latest) latest = at;
  }
  return counts + "|" + latest;
}

async function revalidate(): Promise<void> {
  try {
    const fresh = await request<Snapshot>("GET", "/api/bootstrap");
    checkViewer(fresh);
    const changed = renderFingerprint(fresh) !== renderFingerprint(snap);
    snap = fresh;
    writeCache(fresh);
    emit({ ok: true, path: "/api/bootstrap", refreshed: true, changed });
  } catch (error) {
    emit({ ok: false, path: "/api/bootstrap", error: String(error) });
  }
}

/** 取り直しは初回描画の邪魔をしないよう、手が空いてから始める。 */
function revalidateWhenIdle(): void {
  const start = (): void => { void revalidate(); };
  const idle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  }).requestIdleCallback;
  if (idle) idle(start, { timeout: 2000 });
  else window.setTimeout(start, 300);
}

/**
 * @param options.fresh 控えを使わず必ずサーバーから読む。
 *   計画エディタのように、読み込んだ後に利用者が編集を始める画面で使う
 *   （裏で snap が差し替わると編集中の状態と食い違うため）。
 */
export async function load(options: { fresh?: boolean; strict?: boolean } = {}): Promise<void> {
  if (loaded) return;
  if (loading) return loading;
  if (!api()) {
    loaded = true;
    return;
  }
  if (!options.fresh) {
    const cached = readCache();
    if (cached) {
      snap = cached;
      loaded = true;
      revalidateWhenIdle();
      return;
    }
  }
  loading = (async () => {
    try {
      snap = await request<Snapshot>("GET", "/api/bootstrap");
      checkViewer(snap);
      loaded = true;
      writeCache(snap);
      emit({ ok: true, path: "/api/bootstrap" });
    } catch (error) {
      // 編集画面では空データのまま新規作成すると既存計画と衝突するため失敗を返す。
      // 一覧など読み取り画面は従来どおり空表示で立ち上げられる。
      loaded = !options.strict;
      emit({ ok: false, path: "/api/bootstrap", error: String(error) });
      if (options.strict) throw error;
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** サーバーから読み直す（他端末の変更を取り込む）。控えは使わない。 */
async function reload(): Promise<void> {
  loaded = false;
  loading = null;
  await load({ fresh: true });
}

// ---- 同期読み取り -------------------------------------------------------

export const users = (): UserRow[] => snap.users;
export const credentials = (): CredentialRow[] => snap.credentials;
export const plans = (): PlanRow[] => snap.plans;
export const members = (): PlanMemberRow[] => snap.members;
export const memberPlaceholders = (): PlanMemberPlaceholderRow[] => snap.memberPlaceholders || [];
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
export const pendingInvites = (): PendingInviteRow[] => snap.pendingInvites;
export const friendships = (): FriendshipRow[] => snap.friendships;

function rememberAuthenticatedUser(user: { id: string; display_name: string; email: string }): void {
  const existing = snap.users.find((row) => row.id === user.id);
  if (existing) existing.display_name = user.display_name;
  else snap.users.push({ id: user.id, display_name: user.display_name });
  const credential = snap.credentials.find((row) => row.user_id === user.id);
  if (credential) credential.email = user.email;
  else snap.credentials.push({ user_id: user.id, email: user.email });
}

/**
 * 行き先と日程から旅程の下書きを作ってもらう。
 * 生成そのものは API 側で行う（OpenAI のキーはサーバーにしか置かない）。
 */
export async function suggestItineraryOptions(input: ItineraryAiBaseInput): Promise<ItineraryOptions> {
  return request<ItineraryOptions>("POST", "/api/ai/itinerary-options", input);
}

export async function generateItinerary(input: ItineraryAiGenerateInput): Promise<ItineraryDraft> {
  return request<ItineraryDraft>("POST", "/api/ai/itinerary", input);
}

/** 自分に紐付いている外部ログイン。 */
export function identities(): { provider: string; display_name: string | null }[] {
  return snap.identities || [];
}

/** LINE の紐付けを外す。ログイン手段が無くなる場合はサーバーが断る。 */
export async function unlinkLine(): Promise<void> {
  await request("DELETE", "/api/auth/line/link");
  snap.identities = (snap.identities || []).filter((entry) => entry.provider !== "line");
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

export async function createInvite(planId: string, input: {
  invited_name?: string; invited_user_id?: string; role?: "editor" | "viewer";
}): Promise<{ id: string; token: string }> {
  return request<{ id: string; token: string }>("POST", `/api/plans/${encodeURIComponent(planId)}/invites`, {
    invited_name: input.invited_name || "",
    invited_user_id: input.invited_user_id || "",
    role: input.role || "editor",
  });
}

export async function createPlaceholderMember(planId: string, displayName: string): Promise<{
  user: UserRow;
  member: PlanMemberRow;
}> {
  const result = await request<{ user: UserRow; member: PlanMemberRow }>(
    "POST",
    `/api/plans/${encodeURIComponent(planId)}/placeholder-members`,
    { display_name: displayName },
  );
  if (!snap.users.some((row) => row.id === result.user.id)) snap.users.push(result.user);
  snap.members.push(result.member);
  snap.memberPlaceholders ||= [];
  snap.memberPlaceholders.push({
    plan_id: planId,
    user_id: result.user.id,
    original_name: result.user.display_name,
    status: "unclaimed",
    claimed_by_user_id: null,
    claimed_at: null,
  });
  writeCache(snap);
  return result;
}

export function inspectInvite(token: string): Promise<InviteInspection> {
  return request<InviteInspection>("POST", "/api/invites/inspect", { token });
}

export async function acceptInvite(token: string, memberUserId = ""): Promise<{ planSlug: string }> {
  const result = await request<{ planSlug: string }>("POST", "/api/invites/accept", {
    token,
    member_user_id: memberUserId,
  });
  await reload();
  return result;
}

export function isPlaceholderMember(planId: string, userId: string): boolean {
  return memberPlaceholders().some((row) =>
    row.plan_id === planId && row.user_id === userId && row.status === "unclaimed"
  );
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
    status: input.status || "draft", version: input.version || 1, open_editing: input.open_editing || 0,
    owner_user_id: input.owner_user_id ?? null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  snap.plans.push(row);
  send("POST", "/api/plans", { ...row });
  return row;
}

export function updatePlan(planId: string, patch: Partial<PlanRow>): void {
  const row = planById(planId);
  if (!row || !Object.keys(patch).length) return;
  const expectedVersion = row.version;
  Object.assign(row, patch, { version: expectedVersion + 1 });
  send("PATCH", `/api/plans/${encodeURIComponent(planId)}`, { ...patch, expected_version: expectedVersion });
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
  const plan = planById(planId);
  if (!plan) return;
  const expectedVersion = plan.version;
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
  plan.version = expectedVersion + 1;
  send("PUT", `/api/plans/${encodeURIComponent(planId)}/content`, { ...content, expected_version: expectedVersion });
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
    settled_at: new Date().toISOString(), deleted_at: null,
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

/**
 * DB 同期イベント（trip-db-sync）の購読。
 * 実データが更新された（refreshed かつ changed）ときだけ handler を呼ぶ。
 */
export function onDbSync(handler: () => void): void {
  window.addEventListener("trip-db-sync", (event) => {
    const detail = (event as CustomEvent<{ refreshed?: boolean; changed?: boolean }>).detail;
    if (detail?.refreshed && detail.changed) handler();
  });
}
