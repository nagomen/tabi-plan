// 関係テーブル用のルーティング。server.ts から呼ばれる。
//
//   GET    /api/bootstrap                    起動時に全データを1往復で取得
//   POST   /api/users                        { display_name } / { display_name, ensure:true }
//   PATCH  /api/users/<id>                   { display_name }
//   POST   /api/auth/signup                  { email, password, display_name } → server.ts
//   POST   /api/auth/login                   { email, password } → server.ts
//   PUT    /api/users/<id>/payment-link      { handle }
//   PUT    /api/users/<id>/settings          { history_public }
//   POST   /api/plans                        計画を作る
//   PATCH  /api/plans/<id>                   メタ更新
//   DELETE /api/plans/<id>                   論理削除
//   PUT    /api/plans/<id>/members           参加者を一括置換
//   POST   /api/plans/<id>/owner-transfer    所有権を参加者へ移譲
//   DELETE /api/plans/<id>/members/me        自分が計画から脱退
//   PUT    /api/plans/<id>/content           行程・都市・リンク・チェックリスト・候補を一括置換
//   POST   /api/plans/<id>/views             閲覧を1加算
//   POST   /api/plans/<id>/invites           招待リンクを作る
//   POST   /api/invites/accept               招待リンクを受けて参加する
//   POST   /api/plans/<id>/expenses          費用を1件追加（行の INSERT なので衝突しない）
//   PATCH  /api/expenses/<id>                費用を1件更新
//   DELETE /api/expenses/<id>                論理削除
//   POST   /api/expenses/<id>/restore        元に戻す
//   POST   /api/plans/<id>/settlements       精算を記録
//   POST   /api/friendships                  友達申請/承諾
//   POST   /api/ai/itinerary                 行き先と日程から旅程の下書きを作る

import * as repo from "./plan-repo.js";
import * as accessRepo from "./plan-access-repo.js";
import * as bootstrapRepo from "./bootstrap-repo.js";
import * as inviteRepo from "./plan-invite-repo.js";
import * as memberRepo from "./plan-member-repo.js";
import * as expenseRepo from "./expense-repo.js";
import * as userRepo from "./user-repo.js";
import { PLAN_MANAGE_FIELDS, PLAN_PATCH_FIELDS } from "./plan-contract.js";
import { checkCooldown, generateItinerary } from "./ai-itinerary.js";

export interface Handled {
  status: number;
  body: unknown;
}

type Body = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const PLAN_CONTENT_FIELDS = new Set(["itinerary", "cities", "links", "checklist", "candidates"]);

function expectedVersion(body: Body): number | null {
  if (!Object.prototype.hasOwnProperty.call(body, "expected_version")) return null;
  const value = Number(body.expected_version);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

async function forbiddenUnless(ok: boolean | Promise<boolean>): Promise<Handled | null> {
  return await ok ? null : { status: 403, body: { error: "forbidden" } };
}

async function requireExpenseEdit(expenseId: string, actorUserId: string): Promise<Handled | null> {
  const planId = await expenseRepo.planIdForExpense(expenseId);
  if (!planId) return { status: 404, body: { error: "not found" } };
  return forbiddenUnless(accessRepo.canEditPlanWorkspace(planId, actorUserId));
}

export async function route(method: string, path: string, body: Body, actorUserId = ""): Promise<Handled | null> {
  // ---- 起動時の一括取得 ----
  if (method === "GET" && path === "/api/bootstrap") {
    return { status: 200, body: await bootstrapRepo.bootstrapForUser(actorUserId) };
  }

  // ---- ユーザー ----
  if (method === "POST" && path === "/api/users") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    const name = str(body.display_name);
    const user = body.ensure ? await userRepo.ensureUserByName(name) : await userRepo.createUser(name, str(body.id) || undefined);
    return { status: 200, body: user };
  }
  if (method === "POST" && path === "/api/users/search") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    return { status: 200, body: { users: await userRepo.searchUsers(str(body.query), actorUserId) } };
  }
  let m = /^\/api\/users\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    if (m[1] !== actorUserId) return { status: 403, body: { error: "forbidden" } };
    await userRepo.renameUser(m[1], str(body.display_name));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/credentials$/.exec(path);
  if (m && method === "PUT") {
    return { status: 410, body: { error: "credentials are managed by /api/auth" } };
  }
  if (method === "POST" && path === "/api/users/credentials/lookup") {
    return { status: 410, body: { error: "credentials lookup is disabled" } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/payment-link$/.exec(path);
  if (m && method === "PUT") {
    if (m[1] !== actorUserId) return { status: 403, body: { error: "forbidden" } };
    await userRepo.setPaymentLink(m[1], str(body.handle));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/settings$/.exec(path);
  if (m && method === "PUT") {
    if (m[1] !== actorUserId) return { status: 403, body: { error: "forbidden" } };
    await userRepo.setUserSettings(m[1], Boolean(body.history_public));
    return { status: 200, body: { ok: true } };
  }

  // ---- 計画 ----
  if (method === "POST" && path === "/api/plans") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    return { status: 200, body: await repo.createPlan({ ...body, owner_user_id: actorUserId }) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    if (Object.prototype.hasOwnProperty.call(body, "owner_user_id")) {
      return { status: 400, body: { error: "owner_user_id はこのAPIでは変更できません" } };
    }
    const requestedVersion = expectedVersion(body);
    if (requestedVersion === null) {
      return { status: 400, body: { error: "expected_version が必要です" } };
    }
    const patch = Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expected_version"));
    const unknownFields = Object.keys(patch).filter((key) => !PLAN_PATCH_FIELDS.has(key));
    if (unknownFields.length) {
      return { status: 400, body: { error: `更新できない項目です: ${unknownFields.join(", ")}` } };
    }
    const managesPlan = Object.keys(patch).some((key) => PLAN_MANAGE_FIELDS.has(key));
    const access = await accessRepo.getPlanAccess(m[1], actorUserId);
    const memberEditor = access.canEditWorkspace;
    const denied = await forbiddenUnless(managesPlan ? access.canManage : memberEditor || access.canEdit);
    if (denied) return denied;
    const version = await repo.updatePlan(
      m[1], patch, managesPlan ? "manage" : memberEditor ? "edit" : "collaborate", requestedVersion,
    );
    return { status: 200, body: { ok: true, version } };
  }
  if (m && method === "DELETE") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.deletePlan(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/members$/.exec(path);
  if (m && method === "PUT") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await memberRepo.replaceMembers(m[1], arr(body.members) as { user_id: string; role?: string }[], actorUserId);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/members\/me$/.exec(path);
  if (m && method === "DELETE") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    await memberRepo.leavePlan(m[1], actorUserId);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/owner-transfer$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await memberRepo.transferPlanOwnership(m[1], actorUserId, str(body.user_id));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/content$/.exec(path);
  if (m && method === "PUT") {
    const requestedVersion = expectedVersion(body);
    if (requestedVersion === null) {
      return { status: 400, body: { error: "expected_version が必要です" } };
    }
    const contentEntries = Object.entries(body).filter(([key]) => key !== "expected_version");
    const unknownFields = contentEntries.map(([key]) => key).filter((key) => !PLAN_CONTENT_FIELDS.has(key));
    if (unknownFields.length) {
      return { status: 400, body: { error: `更新できない項目です: ${unknownFields.join(", ")}` } };
    }
    for (const [key, value] of contentEntries) {
      if (!Array.isArray(value) || value.some((item) => !isRecord(item))) {
        return { status: 400, body: { error: `${key} はオブジェクトの配列で指定してください` } };
      }
    }
    const normalizedContent = Object.fromEntries(contentEntries.map(([key, value]) => [key, arr(value)]));
    const access = await accessRepo.getPlanAccess(m[1], actorUserId);
    const memberEditor = access.canEditWorkspace;
    if (!memberEditor) {
      const denied = await forbiddenUnless(access.canEdit);
      if (denied) return denied;
    }
    // 公開共同編集者は旅行本文だけを変更できる。非公開リンクやタスクは正式メンバー用。
    const content = memberEditor
      ? normalizedContent
      : { itinerary: normalizedContent.itinerary, cities: normalizedContent.cities };
    const version = await repo.replacePlanContent(
      m[1], content as Parameters<typeof repo.replacePlanContent>[1], requestedVersion,
    );
    return { status: 200, body: { ok: true, version } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/views$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(accessRepo.canViewPlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.countView(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/invites$/.exec(path);
  if (m && method === "GET") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    return { status: 200, body: { invites: await inviteRepo.listInvites(m[1]) } };
  }
  if (m && method === "POST") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    return {
      status: 200,
      body: await inviteRepo.createInvite({
        planId: m[1],
        createdById: actorUserId,
        invitedName: str(body.invited_name),
        invitedUserId: str(body.invited_user_id),
        role: str(body.role) === "viewer" ? "viewer" : "editor",
      }),
    };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/invites\/([\w-]{1,32})$/.exec(path);
  if (m && method === "DELETE") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await inviteRepo.revokeInvite(m[1], m[2]);
    return { status: 200, body: { ok: true } };
  }
  if (method === "POST" && path === "/api/invites/accept") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    return { status: 200, body: await inviteRepo.acceptInvite(str(body.token), actorUserId) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/expenses$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(accessRepo.canEditPlanWorkspace(m[1], actorUserId));
    if (denied) return denied;
    return { status: 200, body: await expenseRepo.createExpense(m[1], body as unknown as expenseRepo.ExpenseInput, actorUserId) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/expense-audit$/.exec(path);
  if (m && method === "GET") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    return { status: 200, body: { audit: await expenseRepo.listExpenseAudit(m[1]) } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/settlements$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(accessRepo.canEditPlanWorkspace(m[1], actorUserId));
    if (denied) return denied;
    return {
      status: 200,
      body: await expenseRepo.createSettlement(m[1], body as unknown as {
        from_user_id: string; to_user_id: string; amount_base_minor: number;
      }, actorUserId),
    };
  }

  // ---- 費用 ----
  m = /^\/api\/expenses\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    const denied = await requireExpenseEdit(m[1], actorUserId);
    if (denied) return denied;
    await expenseRepo.updateExpense(m[1], body as unknown as expenseRepo.ExpenseInput, actorUserId);
    return { status: 200, body: { ok: true } };
  }
  if (m && method === "DELETE") {
    const denied = await requireExpenseEdit(m[1], actorUserId);
    if (denied) return denied;
    await expenseRepo.deleteExpense(m[1], actorUserId);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/expenses\/([\w-]{1,32})\/restore$/.exec(path);
  if (m && method === "POST") {
    const denied = await requireExpenseEdit(m[1], actorUserId);
    if (denied) return denied;
    await expenseRepo.restoreExpense(m[1], actorUserId);
    return { status: 200, body: { ok: true } };
  }

  // ---- AI（旅程の下書き） ----
  if (method === "POST" && path === "/api/ai/itinerary") {
    // キーはサーバーにしか無い。誰でも叩けると費用が伸びるのでログイン必須。
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    const wait = checkCooldown(actorUserId);
    if (wait > 0) {
      return { status: 429, body: { error: "too_many_requests", retry_after: wait } };
    }
    try {
      const draft = await generateItinerary(actorUserId, {
        area: str(body.area),
        startDate: str(body.start_date),
        endDate: str(body.end_date),
        note: str(body.note),
        people: Number(body.people) || undefined,
      });
      return { status: 200, body: draft };
    } catch (error) {
      return { status: 502, body: { error: error instanceof Error ? error.message : "生成に失敗しました" } };
    }
  }

  // ---- 友達 ----
  if (method === "POST" && path === "/api/friendships") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    const a = str(body.a);
    const b = str(body.b);
    const requestedBy = str(body.requested_by_id);
    const status = str(body.status) || "pending";
    if (![a, b].includes(actorUserId)) return { status: 403, body: { error: "forbidden" } };
    const existing = await userRepo.friendshipBetween(a, b);
    if (status === "pending") {
      if (requestedBy !== actorUserId) return { status: 403, body: { error: "forbidden" } };
    } else if (status === "accepted" || status === "declined") {
      if (!existing || existing.status !== "pending" || existing.requested_by_id === actorUserId) {
        return { status: 403, body: { error: "forbidden" } };
      }
    } else if (status === "canceled") {
      if (!existing || existing.status !== "pending" || existing.requested_by_id !== actorUserId) {
        return { status: 403, body: { error: "forbidden" } };
      }
    } else if (status === "removed") {
      if (!existing || existing.status !== "accepted") return { status: 403, body: { error: "forbidden" } };
    } else {
      return { status: 400, body: { error: "invalid friendship status" } };
    }
    return {
      status: 200,
      body: await userRepo.upsertFriendship({
        a, b, requested_by_id: requestedBy, status,
      }),
    };
  }

  return null; // 該当なし（呼び出し側で 404）
}
