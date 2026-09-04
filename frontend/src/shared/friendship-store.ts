// 友達関係（アカウント単位）。APIモードではDBだけを正とし、
// 旧ローカルモードでだけJSONストアを使う。
// 承諾済みの行がそのまま「友達エッジ」を表す（片方向フォローではなく、双方向の1本の関係）。

import * as Backend from "./backend";
import * as db from "./db";
import { currentAccount, findAccountByEmail, findAccountById, type Account } from "./account-store";

export type FriendRequestStatus = "pending" | "accepted" | "declined" | "canceled" | "removed";

export interface FriendRequestRow {
  id: string;
  fromAccountId: string;
  fromName: string;
  fromEmail: string;
  toAccountId: string;
  toName: string;
  toEmail: string;
  status: FriendRequestStatus;
  createdAt: string;
  respondedAt?: string;
}

export interface FriendshipStore {
  version: 1;
  friendRequests: FriendRequestRow[];
}

export type FriendStatus = "none" | "friends" | "outgoing_pending" | "incoming_pending";

const KEY = "trip-dashboard-friendships";

function nowISO(): string {
  return new Date().toISOString();
}

function id(): string {
  return "freq_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function emptyStore(): FriendshipStore {
  return { version: 1, friendRequests: [] };
}

function readStore(): FriendshipStore {
  const raw = Backend.getJSON<Partial<FriendshipStore>>(KEY, emptyStore());
  return { version: 1, friendRequests: Array.isArray(raw.friendRequests) ? raw.friendRequests : [] };
}

function writeStore(store: FriendshipStore): void {
  Backend.setJSON(KEY, store);
  try {
    window.dispatchEvent(new CustomEvent("trip-friendships-change"));
  } catch {
    /* ignore */
  }
}

function requireAccount(): Account {
  const account = currentAccount();
  if (!account) throw new Error("友達機能を使うにはログインが必要です");
  return account;
}

function involvesAccount(row: FriendRequestRow, accountId: string): boolean {
  return row.fromAccountId === accountId || row.toAccountId === accountId;
}

function otherAccountId(row: FriendRequestRow, accountId: string): string {
  return row.fromAccountId === accountId ? row.toAccountId : row.fromAccountId;
}

function apiAcceptedFriendIds(accountId: string): string[] {
  return db.friendships()
    .filter((row) => row.status === "accepted" && (row.user_low_id === accountId || row.user_high_id === accountId))
    .map((row) => (row.user_low_id === accountId ? row.user_high_id : row.user_low_id));
}

function apiRowsFor(accountId: string): db.FriendshipRow[] {
  return db.friendships().filter((row) => row.user_low_id === accountId || row.user_high_id === accountId);
}

function apiRequestToRow(row: db.FriendshipRow, meId: string): FriendRequestRow {
  const otherId = row.user_low_id === meId ? row.user_high_id : row.user_low_id;
  const other = findAccountById(otherId) || syntheticAccount(otherId);
  const me = currentAccount();
  const fromIsMe = row.requested_by_id === meId;
  return {
    id: row.id,
    fromAccountId: fromIsMe ? meId : otherId,
    fromName: fromIsMe ? (me?.name || me?.email || "") : (other?.name || other?.email || ""),
    fromEmail: fromIsMe ? (me?.email || "") : (other?.email || ""),
    toAccountId: fromIsMe ? otherId : meId,
    toName: fromIsMe ? (other?.name || other?.email || "") : (me?.name || me?.email || ""),
    toEmail: fromIsMe ? (other?.email || "") : (me?.email || ""),
    status: row.status as FriendRequestStatus,
    createdAt: row.created_at,
    respondedAt: row.responded_at || undefined,
  };
}

function syntheticAccount(id: string): Account | null {
  const user = db.users().find((row) => row.id === id);
  if (!user) return null;
  return { id, email: "", name: user.display_name || id, createdAt: "" };
}

/** 2人の間の最新状態を返す（accepted/pending があればそれを優先）。 */
export function statusWith(accountId: string): FriendStatus {
  const me = currentAccount();
  if (!me || me.id === accountId) return "none";
  const apiRow = apiRowsFor(me.id).find((row) =>
    row.user_low_id === accountId || row.user_high_id === accountId,
  );
  if (apiRow?.status === "accepted") return "friends";
  if (apiRow?.status === "pending") return apiRow.requested_by_id === me.id ? "outgoing_pending" : "incoming_pending";
  if (db.isEnabled()) return "none";
  const rows = readStore().friendRequests.filter(
    (row) => involvesAccount(row, me.id) && otherAccountId(row, me.id) === accountId,
  );
  if (rows.some((row) => row.status === "accepted")) return "friends";
  const pending = rows.find((row) => row.status === "pending");
  if (pending) return pending.fromAccountId === me.id ? "outgoing_pending" : "incoming_pending";
  return "none";
}

/** 友達申請を送る。相手アカウントIDまたはメールアドレスのどちらかを指定する。 */
export async function sendFriendRequest(target: { accountId?: string; email?: string }): Promise<FriendRequestRow> {
  const me = requireAccount();
  const to = target.accountId ? findAccountById(target.accountId) : target.email ? findAccountByEmail(target.email) : null;
  if (!to) throw new Error("宛先のアカウントが見つかりません");
  if (to.id === me.id) throw new Error("自分自身には申請できません");
  const existing = statusWith(to.id);
  if (existing === "friends") throw new Error("すでに友達です");
  if (existing === "outgoing_pending" || existing === "incoming_pending") throw new Error("すでに申請が保留中です");

  const row: FriendRequestRow = {
    id: id(),
    fromAccountId: me.id,
    fromName: me.name || me.email,
    fromEmail: me.email,
    toAccountId: to.id,
    toName: to.name || to.email,
    toEmail: to.email,
    status: "pending",
    createdAt: nowISO(),
  };
  if (db.isEnabled()) {
    await db.saveFriendship({ a: me.id, b: to.id, requested_by_id: me.id, status: "pending" });
    const saved = apiRowsFor(me.id).find((candidate) =>
      candidate.user_low_id === to.id || candidate.user_high_id === to.id,
    );
    return saved ? apiRequestToRow(saved, me.id) : row;
  }
  writeStore({ version: 1, friendRequests: readStore().friendRequests.concat(row) });
  return row;
}

function updateRequestStatus(
  requestId: string,
  guard: (row: FriendRequestRow, meId: string) => boolean,
  nextStatus: FriendRequestStatus,
): FriendRequestRow | null {
  const me = requireAccount();
  const store = readStore();
  const row = store.friendRequests.find((r) => r.id === requestId);
  if (!row || !guard(row, me.id)) return null;
  row.status = nextStatus;
  row.respondedAt = nowISO();
  writeStore(store);
  return row;
}

async function updateApiRequestStatus(
  requestId: string,
  guard: (row: db.FriendshipRow, meId: string) => boolean,
  nextStatus: FriendRequestStatus,
): Promise<FriendRequestRow | null> {
  const me = requireAccount();
  const apiRow = db.friendships().find((row) => row.id === requestId);
  if (!apiRow || !guard(apiRow, me.id)) return null;
  const result = apiRequestToRow(apiRow, me.id);
  await db.saveFriendship({
    a: apiRow.user_low_id,
    b: apiRow.user_high_id,
    requested_by_id: apiRow.requested_by_id,
    status: nextStatus,
  });
  result.status = nextStatus;
  result.respondedAt = nowISO();
  return result;
}

/** 届いた申請を承諾する（受信者のみ実行可）。 */
export async function acceptFriendRequest(requestId: string): Promise<FriendRequestRow | null> {
  if (db.isEnabled()) return updateApiRequestStatus(
    requestId,
    (row, meId) => row.status === "pending" && row.requested_by_id !== meId,
    "accepted",
  );
  return updateRequestStatus(
    requestId,
    (row, meId) => row.toAccountId === meId && row.status === "pending",
    "accepted",
  );
}

/** 届いた申請を拒否する（受信者のみ実行可）。 */
export async function declineFriendRequest(requestId: string): Promise<FriendRequestRow | null> {
  if (db.isEnabled()) return updateApiRequestStatus(
    requestId,
    (row, meId) => row.status === "pending" && row.requested_by_id !== meId,
    "declined",
  );
  return updateRequestStatus(
    requestId,
    (row, meId) => row.toAccountId === meId && row.status === "pending",
    "declined",
  );
}

/** 送った申請を取り消す（送信者のみ実行可）。 */
export async function cancelFriendRequest(requestId: string): Promise<FriendRequestRow | null> {
  if (db.isEnabled()) return updateApiRequestStatus(
    requestId,
    (row, meId) => row.status === "pending" && row.requested_by_id === meId,
    "canceled",
  );
  return updateRequestStatus(
    requestId,
    (row, meId) => row.fromAccountId === meId && row.status === "pending",
    "canceled",
  );
}

/** 友達を解除する。 */
export async function removeFriend(accountId: string): Promise<void> {
  const me = requireAccount();
  const at = nowISO();
  if (db.isEnabled()) {
    await db.saveFriendship({ a: me.id, b: accountId, requested_by_id: me.id, status: "removed" });
    return;
  }
  const store = readStore();
  let changed = false;
  store.friendRequests.forEach((row) => {
    if (row.status === "accepted" && involvesAccount(row, me.id) && otherAccountId(row, me.id) === accountId) {
      row.status = "removed";
      row.respondedAt = at;
      changed = true;
    }
  });
  if (changed) writeStore(store);
}

/** 自分が絡む承諾済みの友達（アカウント情報）を返す。 */
export function listFriends(): Account[] {
  const me = currentAccount();
  if (!me) return [];
  const ids = [
    ...apiAcceptedFriendIds(me.id),
    ...(db.isEnabled() ? [] : readStore()
    .friendRequests.filter((row) => row.status === "accepted" && involvesAccount(row, me.id))
    .map((row) => otherAccountId(row, me.id))),
  ];
  return Array.from(new Set(ids))
    .map((accountId) => findAccountById(accountId) || syntheticAccount(accountId))
    .filter((a): a is Account => Boolean(a));
}

/** 自分宛ての保留中の申請。 */
export function incomingRequests(): FriendRequestRow[] {
  const me = currentAccount();
  if (!me) return [];
  if (db.isEnabled()) return apiRowsFor(me.id)
      .filter((row) => row.status === "pending" && row.requested_by_id !== me.id)
      .map((row) => apiRequestToRow(row, me.id));
  return readStore().friendRequests.filter((row) => row.status === "pending" && row.toAccountId === me.id);
}

/** 自分が送った保留中の申請。 */
export function outgoingRequests(): FriendRequestRow[] {
  const me = currentAccount();
  if (!me) return [];
  if (db.isEnabled()) return apiRowsFor(me.id)
      .filter((row) => row.status === "pending" && row.requested_by_id === me.id)
      .map((row) => apiRequestToRow(row, me.id));
  return readStore().friendRequests.filter((row) => row.status === "pending" && row.fromAccountId === me.id);
}
