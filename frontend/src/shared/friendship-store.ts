// 友達関係（アカウント単位）をDBテーブル風JSONで管理する。
// permissions-store.ts と同じパターン: 配列=テーブル、各要素=行、id/外部キー/状態列を明示する。
// 承諾済みの行がそのまま「友達エッジ」を表す（片方向フォローではなく、双方向の1本の関係）。

import * as Backend from "./backend";
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

/** 2人の間の最新状態を返す（accepted/pending があればそれを優先）。 */
export function statusWith(accountId: string): FriendStatus {
  const me = currentAccount();
  if (!me || me.id === accountId) return "none";
  const rows = readStore().friendRequests.filter(
    (row) => involvesAccount(row, me.id) && otherAccountId(row, me.id) === accountId,
  );
  if (rows.some((row) => row.status === "accepted")) return "friends";
  const pending = rows.find((row) => row.status === "pending");
  if (pending) return pending.fromAccountId === me.id ? "outgoing_pending" : "incoming_pending";
  return "none";
}

/** 友達申請を送る。相手アカウントIDまたはメールアドレスのどちらかを指定する。 */
export function sendFriendRequest(target: { accountId?: string; email?: string }): FriendRequestRow {
  const me = requireAccount();
  const to = target.accountId ? findAccountById(target.accountId) : target.email ? findAccountByEmail(target.email) : null;
  if (!to) throw new Error("宛先のアカウントが見つかりません");
  if (to.id === me.id) throw new Error("自分自身には申請できません");
  const existing = statusWith(to.id);
  if (existing === "friends") throw new Error("すでに友達です");
  if (existing === "outgoing_pending" || existing === "incoming_pending") throw new Error("すでに申請が保留中です");

  const store = readStore();
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
  store.friendRequests.push(row);
  writeStore(store);
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

/** 届いた申請を承諾する（受信者のみ実行可）。 */
export function acceptFriendRequest(requestId: string): FriendRequestRow | null {
  return updateRequestStatus(
    requestId,
    (row, meId) => row.toAccountId === meId && row.status === "pending",
    "accepted",
  );
}

/** 届いた申請を拒否する（受信者のみ実行可）。 */
export function declineFriendRequest(requestId: string): FriendRequestRow | null {
  return updateRequestStatus(
    requestId,
    (row, meId) => row.toAccountId === meId && row.status === "pending",
    "declined",
  );
}

/** 送った申請を取り消す（送信者のみ実行可）。 */
export function cancelFriendRequest(requestId: string): FriendRequestRow | null {
  return updateRequestStatus(
    requestId,
    (row, meId) => row.fromAccountId === meId && row.status === "pending",
    "canceled",
  );
}

/** 友達を解除する。 */
export function removeFriend(accountId: string): void {
  const me = requireAccount();
  const store = readStore();
  const at = nowISO();
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
  const ids = readStore()
    .friendRequests.filter((row) => row.status === "accepted" && involvesAccount(row, me.id))
    .map((row) => otherAccountId(row, me.id));
  return Array.from(new Set(ids))
    .map((accountId) => findAccountById(accountId))
    .filter((a): a is Account => Boolean(a));
}

/** 自分宛ての保留中の申請。 */
export function incomingRequests(): FriendRequestRow[] {
  const me = currentAccount();
  if (!me) return [];
  return readStore().friendRequests.filter((row) => row.status === "pending" && row.toAccountId === me.id);
}

/** 自分が送った保留中の申請。 */
export function outgoingRequests(): FriendRequestRow[] {
  const me = currentAccount();
  if (!me) return [];
  return readStore().friendRequests.filter((row) => row.status === "pending" && row.fromAccountId === me.id);
}
