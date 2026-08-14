// 計画ごとの権限・招待をDBテーブル風JSONで管理する。
// 将来DBへ移行しやすいよう、配列=テーブル、各要素=行、id/外部キー/状態列を明示する。

import * as Backend from "./backend";
import { currentAccount } from "./account-store";
import { getUser, setUserName } from "./user-store";
import { safeTripSlug } from "./config";
import { splitNames } from "./friend-store";
import * as db from "./db";
import { currentUserId } from "./identity";

export type PermissionSubjectType = "account" | "name";
export type PlanRole = "owner" | "editor" | "viewer";
export type PermissionStatus = "active" | "revoked";
export type InviteStatus = "pending" | "accepted" | "revoked";

export interface PermissionPrincipal {
  subjectType: PermissionSubjectType;
  subjectId: string;
  displayName: string;
  accountId?: string;
}

export interface PlanPermissionRow {
  id: string;
  planSlug: string;
  subjectType: PermissionSubjectType;
  subjectId: string;
  displayName: string;
  role: PlanRole;
  status: PermissionStatus;
  source: "owner" | "invite" | "manual" | "legacy";
  inviteId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanInviteRow {
  id: string;
  planSlug: string;
  invitedName?: string;
  role: PlanRole;
  status: InviteStatus;
  createdBySubjectType: PermissionSubjectType;
  createdBySubjectId: string;
  createdByName: string;
  acceptedBySubjectType?: PermissionSubjectType;
  acceptedBySubjectId?: string;
  acceptedByName?: string;
  createdAt: string;
  acceptedAt?: string;
  revokedAt?: string;
}

export interface PermissionStore {
  version: 1;
  planPermissions: PlanPermissionRow[];
  planInvites: PlanInviteRow[];
}

const KEY = "trip-dashboard-permissions";
const ROLE_RANK: Record<PlanRole, number> = { viewer: 1, editor: 2, owner: 3 };

function nowISO(): string {
  return new Date().toISOString();
}

function id(prefix: string): string {
  return prefix + "_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function emptyStore(): PermissionStore {
  return { version: 1, planPermissions: [], planInvites: [] };
}

export function readPermissionStore(): PermissionStore {
  const raw = Backend.getJSON<Partial<PermissionStore>>(KEY, emptyStore());
  return {
    version: 1,
    planPermissions: Array.isArray(raw.planPermissions) ? raw.planPermissions : [],
    planInvites: Array.isArray(raw.planInvites) ? raw.planInvites : [],
  };
}

function writePermissionStore(store: PermissionStore): void {
  Backend.setJSON(KEY, store);
}

export function currentPrincipal(fallbackName?: string): PermissionPrincipal | null {
  const account = currentAccount();
  if (account) {
    return {
      subjectType: "account",
      subjectId: account.id,
      displayName: account.name || account.email,
      accountId: account.id,
    };
  }
  const name = (getUser().name || fallbackName || "").trim();
  if (!name) return null;
  return { subjectType: "name", subjectId: name, displayName: name };
}

function samePrincipal(row: Pick<PlanPermissionRow, "subjectType" | "subjectId">, principal: PermissionPrincipal): boolean {
  return row.subjectType === principal.subjectType && row.subjectId === principal.subjectId;
}

function upsertPermission(
  store: PermissionStore,
  input: {
    planSlug: string;
    principal: PermissionPrincipal;
    role: PlanRole;
    source: PlanPermissionRow["source"];
    inviteId?: string;
  },
): void {
  const planSlug = safeTripSlug(input.planSlug);
  const existing = store.planPermissions.find((row) => row.planSlug === planSlug && samePrincipal(row, input.principal));
  const at = nowISO();
  if (existing) {
    existing.displayName = input.principal.displayName;
    existing.role = ROLE_RANK[input.role] > ROLE_RANK[existing.role] ? input.role : existing.role;
    existing.status = "active";
    existing.inviteId = input.inviteId || existing.inviteId;
    existing.updatedAt = at;
    return;
  }
  store.planPermissions.push({
    id: id("perm"),
    planSlug,
    subjectType: input.principal.subjectType,
    subjectId: input.principal.subjectId,
    displayName: input.principal.displayName,
    role: input.role,
    status: "active",
    source: input.source,
    inviteId: input.inviteId,
    createdAt: at,
    updatedAt: at,
  });
}

export function ensureOwner(planSlug: string, members?: string): void {
  const principal = currentPrincipal();
  if (!principal) return;
  const slug = safeTripSlug(planSlug);
  const store = readPermissionStore();
  const active = store.planPermissions.some((row) => row.planSlug === slug && row.status === "active");
  upsertPermission(store, { planSlug: slug, principal, role: active ? "editor" : "owner", source: active ? "manual" : "owner" });
  splitNames(members).forEach((name) => {
    if (!name || name === principal.displayName) return;
    upsertPermission(
      store,
      { planSlug: slug, principal: { subjectType: "name", subjectId: name, displayName: name }, role: "editor", source: "manual" },
    );
  });
  writePermissionStore(store);
}

export function createInvite(planSlug: string, invitedName?: string, role: PlanRole = "editor"): PlanInviteRow | null {
  const creator = currentPrincipal();
  if (!creator) return null;
  const store = readPermissionStore();
  const at = nowISO();
  const invite: PlanInviteRow = {
    id: id("inv"),
    planSlug: safeTripSlug(planSlug),
    invitedName: (invitedName || "").trim() || undefined,
    role,
    status: "pending",
    createdBySubjectType: creator.subjectType,
    createdBySubjectId: creator.subjectId,
    createdByName: creator.displayName,
    createdAt: at,
  };
  store.planInvites.push(invite);
  writePermissionStore(store);
  return invite;
}

/** 招待の受け入れ結果。granted=false なら権限を付けていない。 */
export interface AcceptInviteResult {
  granted: boolean;
  role?: PlanRole;
  invite: PlanInviteRow | null;
  reason?: "revoked" | "no-principal";
}

/**
 * 招待リンクを受け入れて権限行を作る。
 *
 * 招待行（planInvites）は招待した側の端末にしか無いため、受け取り側では通常見つからない。
 * そのため役割はリンクに埋め込まれた requestedRole を正とし、招待行が手元にある場合だけ
 * 状態（revoked）と役割を突き合わせて上書きする。
 * リンクに役割が無い旧リンクは editor 扱い（従来互換）。
 */
export function acceptInvite(
  planSlug: string,
  inviteId?: string,
  invitedName?: string,
  requestedRole?: PlanRole,
): AcceptInviteResult {
  const fallbackName = (invitedName || "").trim();
  if (fallbackName && !getUser().name.trim()) setUserName(fallbackName);
  const principal = currentPrincipal(fallbackName);
  if (!principal) return { granted: false, invite: null, reason: "no-principal" };
  const slug = safeTripSlug(planSlug);
  const store = readPermissionStore();
  const invite = inviteId
    ? store.planInvites.find((row) => row.id === inviteId && row.planSlug === slug) || null
    : null;
  // 取り消された招待は手元に行があるときだけ判定できる。分かるなら拒否する。
  if (invite && invite.status === "revoked") {
    return { granted: false, invite, reason: "revoked" };
  }
  const role: PlanRole = invite?.role || requestedRole || "editor";
  upsertPermission(store, { planSlug: slug, principal, role, source: "invite", inviteId: invite?.id });
  if (invite) {
    invite.status = "accepted";
    invite.acceptedBySubjectType = principal.subjectType;
    invite.acceptedBySubjectId = principal.subjectId;
    invite.acceptedByName = principal.displayName;
    invite.acceptedAt = nowISO();
  }
  writePermissionStore(store);
  return { granted: true, role, invite };
}

/** 招待を取り消す（以後この招待IDでは権限を付けられない）。 */
export function revokeInvite(inviteId: string): boolean {
  const store = readPermissionStore();
  const invite = store.planInvites.find((row) => row.id === inviteId);
  if (!invite || invite.status === "revoked") return false;
  invite.status = "revoked";
  invite.revokedAt = nowISO();
  // その招待で配った権限も止める
  store.planPermissions.forEach((row) => {
    if (row.inviteId === inviteId && row.status === "active") {
      row.status = "revoked";
      row.updatedAt = nowISO();
    }
  });
  writePermissionStore(store);
  return true;
}

/**
 * ログイン時に、名前 principal で持っていた権限をアカウントへ引き継ぐ。
 * 未ログインで作った計画にログイン後アクセスすると permissionFor が空振りし、
 * 自分の計画なのに閲覧のみになってしまうのを防ぐ。冪等。
 */
export function adoptNamePermissions(): void {
  const account = currentAccount();
  const name = (account?.name || "").trim();
  if (!account || !name) return;
  const store = readPermissionStore();
  const nameRows = store.planPermissions.filter(
    (row) => row.subjectType === "name" && row.subjectId === name && row.status === "active",
  );
  let changed = false;
  nameRows.forEach((row) => {
    const owned = store.planPermissions.find(
      (other) =>
        other.planSlug === row.planSlug &&
        other.subjectType === "account" &&
        other.subjectId === account.id,
    );
    if (!owned) {
      store.planPermissions.push({
        ...row,
        id: id("perm"),
        subjectType: "account",
        subjectId: account.id,
        displayName: name,
        updatedAt: nowISO(),
      });
      changed = true;
      return;
    }
    if (owned.status !== "active") {
      owned.status = "active";
      owned.updatedAt = nowISO();
      changed = true;
    }
    if (ROLE_RANK[row.role] > ROLE_RANK[owned.role]) {
      owned.role = row.role;
      owned.updatedAt = nowISO();
      changed = true;
    }
  });
  if (changed) writePermissionStore(store);
}

/**
 * 表示名を変更したとき、名前キーの権限行を新しい名前へ移す。
 * 名前が主キーになっている箇所（membership の名前一致）を壊さないため。
 */
export function renameNamePrincipal(oldName: string, newName: string): void {
  const from = (oldName || "").trim();
  const to = (newName || "").trim();
  if (!from || !to || from === to) return;
  const store = readPermissionStore();
  let changed = false;
  store.planPermissions.forEach((row) => {
    if (row.subjectType === "name" && row.subjectId === from) {
      row.subjectId = to;
      row.displayName = to;
      row.updatedAt = nowISO();
      changed = true;
    } else if (row.displayName === from) {
      row.displayName = to;
      row.updatedAt = nowISO();
      changed = true;
    }
  });
  store.planInvites.forEach((invite) => {
    if (invite.invitedName === from) { invite.invitedName = to; changed = true; }
    if (invite.createdByName === from) { invite.createdByName = to; changed = true; }
    if (invite.acceptedByName === from) { invite.acceptedByName = to; changed = true; }
    if (invite.createdBySubjectType === "name" && invite.createdBySubjectId === from) {
      invite.createdBySubjectId = to;
      changed = true;
    }
    if (invite.acceptedBySubjectType === "name" && invite.acceptedBySubjectId === from) {
      invite.acceptedBySubjectId = to;
      changed = true;
    }
  });
  if (changed) writePermissionStore(store);
}

export function permissionFor(planSlug: string, principal = currentPrincipal()): PlanPermissionRow | null {
  if (!principal) return null;
  const slug = safeTripSlug(planSlug);
  const rows = readPermissionStore().planPermissions
    .filter((row) => row.planSlug === slug && row.status === "active" && samePrincipal(row, principal))
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]);
  return rows[0] || null;
}

/** その計画に有効な権限行が1件でもあるか（＝持ち主が確定しているか）。 */
export function hasAnyPermission(planSlug: string): boolean {
  const slug = safeTripSlug(planSlug);
  return readPermissionStore().planPermissions.some(
    (row) => row.planSlug === slug && row.status === "active",
  );
}

export function pendingInvitesForCurrentUser(): PlanInviteRow[] {
  const principal = currentPrincipal();
  if (!principal) return [];
  return readPermissionStore().planInvites.filter((invite) => {
    if (invite.status !== "pending") return false;
    if (invite.acceptedBySubjectId) return false;
    if (invite.invitedName && invite.invitedName !== principal.displayName) return false;
    return true;
  });
}

export function roleLabel(role: PlanRole | undefined): string {
  if (role === "owner") return "Owner";
  if (role === "editor") return "Editor";
  if (role === "viewer") return "Viewer";
  return "Guest";
}

export function canView(planSlug: string, visibility: "public" | "invite" = "public"): boolean {
  if (visibility === "public") return true;
  return isParticipant(planSlug);
}

/**
 * 編集できるか。plan_members が正。
 * 旧 planPermissions は移行済みなので参照しない。
 */
export function canEdit(planSlug: string): boolean {
  const slug = safeTripSlug(planSlug);
  const row = db.planBySlug(slug);
  if (!row) return false;
  const me = currentUserId();
  if (!me) return false;
  const member = db.members().find((m) => m.plan_id === row.id && m.user_id === me);
  if (member && (member.role === "owner" || member.role === "editor")) return true;
  return Boolean(row.open_editing && row.visibility === "public" && row.status === "published");
}

export function isParticipant(planSlug: string): boolean {
  const row = db.planBySlug(safeTripSlug(planSlug));
  const me = currentUserId();
  if (!row || !me) return false;
  return db.members().some((m) => m.plan_id === row.id && m.user_id === me);
}
