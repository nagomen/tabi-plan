// 計画ごとの権限・招待をDBテーブル風JSONで管理する。
// 将来DBへ移行しやすいよう、配列=テーブル、各要素=行、id/外部キー/状態列を明示する。

import * as Backend from "./backend";
import { currentAccount } from "./account-store";
import { getUser, setUserName } from "./user-store";
import { safeTripSlug } from "./config";
import { splitNames } from "./friend-store";

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

export function acceptInvite(planSlug: string, inviteId?: string, invitedName?: string): PlanInviteRow | null {
  const fallbackName = (invitedName || "").trim();
  if (fallbackName && !getUser().name.trim()) setUserName(fallbackName);
  const principal = currentPrincipal(fallbackName);
  if (!principal) return null;
  const slug = safeTripSlug(planSlug);
  const store = readPermissionStore();
  const invite = inviteId
    ? store.planInvites.find((row) => row.id === inviteId && row.planSlug === slug)
    : null;
  const role = invite?.role || "editor";
  upsertPermission(store, { planSlug: slug, principal, role, source: "invite", inviteId: invite?.id });
  if (invite) {
    invite.status = "accepted";
    invite.acceptedBySubjectType = principal.subjectType;
    invite.acceptedBySubjectId = principal.subjectId;
    invite.acceptedByName = principal.displayName;
    invite.acceptedAt = nowISO();
  }
  writePermissionStore(store);
  return invite || null;
}

export function permissionFor(planSlug: string, principal = currentPrincipal()): PlanPermissionRow | null {
  if (!principal) return null;
  const slug = safeTripSlug(planSlug);
  const rows = readPermissionStore().planPermissions
    .filter((row) => row.planSlug === slug && row.status === "active" && samePrincipal(row, principal))
    .sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role]);
  return rows[0] || null;
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
  return Boolean(permissionFor(planSlug));
}

export function canEdit(planSlug: string): boolean {
  const permission = permissionFor(planSlug);
  return Boolean(permission && (permission.role === "owner" || permission.role === "editor"));
}

export function isParticipant(planSlug: string, memberNames: string[] = []): boolean {
  const permission = permissionFor(planSlug);
  if (permission) return true;
  const principal = currentPrincipal();
  if (!principal) return false;
  return memberNames.includes(principal.displayName);
}
