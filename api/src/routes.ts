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

import * as repo from "./repo.js";

export interface Handled {
  status: number;
  body: unknown;
}

type Body = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v : []);
const PLAN_MANAGE_FIELDS = new Set([
  "slug", "source", "visibility", "status", "open_editing", "owner_user_id",
  "external_spreadsheet_id", "external_apps_script_url", "external_schema",
]);
const PLAN_EDIT_FIELDS = new Set([
  "title", "note", "start_date", "end_date", "dates_label", "cover_url", "base_currency",
]);
const PLAN_PATCH_FIELDS = new Set([...PLAN_EDIT_FIELDS, ...PLAN_MANAGE_FIELDS]);

async function forbiddenUnless(ok: boolean | Promise<boolean>): Promise<Handled | null> {
  return await ok ? null : { status: 403, body: { error: "forbidden" } };
}

async function requireExpenseEdit(expenseId: string, actorUserId: string): Promise<Handled | null> {
  const planId = await repo.planIdForExpense(expenseId);
  if (!planId) return { status: 404, body: { error: "not found" } };
  return forbiddenUnless(repo.canEditPlanWorkspace(planId, actorUserId));
}

export async function route(method: string, path: string, body: Body, actorUserId = ""): Promise<Handled | null> {
  // ---- 起動時の一括取得 ----
  if (method === "GET" && path === "/api/bootstrap") {
    return { status: 200, body: await repo.bootstrapForUser(actorUserId) };
  }

  // ---- ユーザー ----
  if (method === "POST" && path === "/api/users") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    const name = str(body.display_name);
    const user = body.ensure ? await repo.ensureUserByName(name) : await repo.createUser(name, str(body.id) || undefined);
    return { status: 200, body: user };
  }
  if (method === "POST" && path === "/api/users/search") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    return { status: 200, body: { users: await repo.searchUsers(str(body.query), actorUserId) } };
  }
  let m = /^\/api\/users\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    if (m[1] !== actorUserId) return { status: 403, body: { error: "forbidden" } };
    await repo.renameUser(m[1], str(body.display_name));
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
    await repo.setPaymentLink(m[1], str(body.handle));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/users\/([\w-]{1,32})\/settings$/.exec(path);
  if (m && method === "PUT") {
    if (m[1] !== actorUserId) return { status: 403, body: { error: "forbidden" } };
    await repo.setUserSettings(m[1], Boolean(body.history_public));
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
    const unknownFields = Object.keys(body).filter((key) => !PLAN_PATCH_FIELDS.has(key));
    if (unknownFields.length) {
      return { status: 400, body: { error: `更新できない項目です: ${unknownFields.join(", ")}` } };
    }
    const managesPlan = Object.keys(body).some((key) => PLAN_MANAGE_FIELDS.has(key));
    const memberEditor = await repo.canEditPlanWorkspace(m[1], actorUserId);
    const denied = await forbiddenUnless(managesPlan
      ? repo.canManagePlan(m[1], actorUserId)
      : memberEditor || repo.canEditPlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.updatePlan(m[1], body, managesPlan ? "manage" : memberEditor ? "edit" : "collaborate");
    return { status: 200, body: { ok: true } };
  }
  if (m && method === "DELETE") {
    const denied = await forbiddenUnless(repo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.deletePlan(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/members$/.exec(path);
  if (m && method === "PUT") {
    const denied = await forbiddenUnless(repo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.replaceMembers(m[1], arr(body.members) as { user_id: string; role?: string }[], actorUserId);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/members\/me$/.exec(path);
  if (m && method === "DELETE") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    await repo.leavePlan(m[1], actorUserId);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/owner-transfer$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(repo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.transferPlanOwnership(m[1], actorUserId, str(body.user_id));
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/content$/.exec(path);
  if (m && method === "PUT") {
    const memberEditor = await repo.canEditPlanWorkspace(m[1], actorUserId);
    if (!memberEditor) {
      const denied = await forbiddenUnless(repo.canEditPlan(m[1], actorUserId));
      if (denied) return denied;
    }
    // 公開共同編集者は旅行本文だけを変更できる。非公開リンクやタスクは正式メンバー用。
    const content = memberEditor ? body : { itinerary: body.itinerary, cities: body.cities };
    await repo.replacePlanContent(m[1], content as Parameters<typeof repo.replacePlanContent>[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/views$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(repo.canViewPlan(m[1], actorUserId));
    if (denied) return denied;
    await repo.countView(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/invites$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(repo.canInvitePlan(m[1], actorUserId));
    if (denied) return denied;
    return {
      status: 200,
      body: await repo.createInvite({
        planId: m[1],
        createdById: actorUserId,
        invitedName: str(body.invited_name),
        role: str(body.role) === "viewer" ? "viewer" : "editor",
      }),
    };
  }
  if (method === "POST" && path === "/api/invites/accept") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    return { status: 200, body: await repo.acceptInvite(str(body.token), actorUserId) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/expenses$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(repo.canEditPlanWorkspace(m[1], actorUserId));
    if (denied) return denied;
    return { status: 200, body: await repo.createExpense(m[1], body as unknown as repo.ExpenseInput, actorUserId) };
  }
  m = /^\/api\/plans\/([\w-]{1,32})\/settlements$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(repo.canEditPlanWorkspace(m[1], actorUserId));
    if (denied) return denied;
    return {
      status: 200,
      body: await repo.createSettlement(m[1], body as unknown as {
        from_user_id: string; to_user_id: string; amount_base_minor: number;
      }, actorUserId),
    };
  }

  // ---- 費用 ----
  m = /^\/api\/expenses\/([\w-]{1,32})$/.exec(path);
  if (m && method === "PATCH") {
    const denied = await requireExpenseEdit(m[1], actorUserId);
    if (denied) return denied;
    await repo.updateExpense(m[1], body as unknown as repo.ExpenseInput);
    return { status: 200, body: { ok: true } };
  }
  if (m && method === "DELETE") {
    const denied = await requireExpenseEdit(m[1], actorUserId);
    if (denied) return denied;
    await repo.deleteExpense(m[1]);
    return { status: 200, body: { ok: true } };
  }
  m = /^\/api\/expenses\/([\w-]{1,32})\/restore$/.exec(path);
  if (m && method === "POST") {
    const denied = await requireExpenseEdit(m[1], actorUserId);
    if (denied) return denied;
    await repo.restoreExpense(m[1]);
    return { status: 200, body: { ok: true } };
  }

  // ---- 友達 ----
  if (method === "POST" && path === "/api/friendships") {
    if (!actorUserId) return { status: 403, body: { error: "forbidden" } };
    const a = str(body.a);
    const b = str(body.b);
    const requestedBy = str(body.requested_by_id);
    const status = str(body.status) || "pending";
    if (![a, b].includes(actorUserId)) return { status: 403, body: { error: "forbidden" } };
    const existing = await repo.friendshipBetween(a, b);
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
      body: await repo.upsertFriendship({
        a, b, requested_by_id: requestedBy, status,
      }),
    };
  }

  return null; // 該当なし（呼び出し側で 404）
}
