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
//   POST   /api/plans/<id>/placeholder-members 名前だけの未登録参加者を追加
//   POST   /api/plans/<id>/owner-transfer    所有権を参加者へ移譲
//   DELETE /api/plans/<id>/members/me        自分が計画から脱退
//   PUT    /api/plans/<id>/content           行程・都市・リンク・チェックリスト・候補を一括置換
//   POST   /api/plans/<id>/views             閲覧を1加算
//   POST   /api/plans/<id>/invites           招待リンクを作る
//   POST   /api/invites/accept               招待リンクを受けて参加する
//   POST   /api/invites/inspect              ログイン前に招待対象を確認する
//   POST   /api/plans/<id>/expenses          費用を1件追加（行の INSERT なので衝突しない）
//   PATCH  /api/expenses/<id>                費用を1件更新
//   DELETE /api/expenses/<id>                論理削除
//   POST   /api/expenses/<id>/restore        元に戻す
//   POST   /api/plans/<id>/settlements       精算を記録
//   POST   /api/friendships                  友達申請/承諾
//   DELETE /api/auth/line/link               LINE の紐付けを外す
//   POST   /api/ai/itinerary-options         行き先から選択用の観光候補を作る
//   POST   /api/ai/itinerary                 選択候補と条件から旅程の下書きを作る
//   POST   /api/ai/itinerary-refine          既存の全行程をチャットの依頼で修正する

import * as repo from "./plan-repo.js";
import * as accessRepo from "./plan-access-repo.js";
import * as bootstrapRepo from "./bootstrap-repo.js";
import * as inviteRepo from "./plan-invite-repo.js";
import * as memberRepo from "./plan-member-repo.js";
import * as expenseRepo from "./expense-repo.js";
import * as userRepo from "./user-repo.js";
import { PLAN_MANAGE_FIELDS, PLAN_PATCH_FIELDS } from "./plan-contract.js";
import { generateItinerary, MAX_AI_CITIES, suggestItineraryOptions, type ItineraryInput } from "./ai-itinerary.js";
import { refineItinerary } from "./ai-itinerary-refine.js";
import type { ItineraryKind, ItineraryRefineInput, ItineraryRefineItem } from "@tabi/contracts";
import { AiInputError, AiOutputError, AiUnavailableError, AiUpstreamError } from "./ai-errors.js";
import { BadRequest } from "./errors.js";
import { reserveAiRequest, type AiScope } from "./ai-usage-repo.js";
import { unlinkLine } from "./line-auth.js";

export interface Handled {
  status: number;
  body: unknown;
}

type Body = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);
const strArr = (v: unknown): string[] => Array.isArray(v)
  ? v.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean)
  : [];
const PLAN_CONTENT_FIELDS = new Set(["itinerary", "cities", "links", "checklist", "candidates"]);
const ITINERARY_KINDS = new Set<ItineraryKind>(["sight", "move", "food", "stay", "todo", "form"]);

function itineraryInput(body: Body): ItineraryInput {
  const rawPreferences = isRecord(body.preferences) ? body.preferences : {};
  const pace = ["ゆったり", "標準", "充実"].includes(str(rawPreferences.pace))
    ? str(rawPreferences.pace) as "ゆったり" | "標準" | "充実"
    : "標準";
  const walking = ["少なめ", "標準", "気にしない"].includes(str(rawPreferences.walking))
    ? str(rawPreferences.walking) as "少なめ" | "標準" | "気にしない"
    : "標準";
  const transport = ["公共交通", "車", "おまかせ"].includes(str(rawPreferences.transport))
    ? str(rawPreferences.transport) as "公共交通" | "車" | "おまかせ"
    : "おまかせ";
  const peopleValue = body.people === undefined || body.people === null || body.people === ""
    ? undefined
    : Number(body.people);
  if (peopleValue !== undefined && (!Number.isSafeInteger(peopleValue) || peopleValue < 1 || peopleValue > 100)) {
    throw new AiInputError("人数は1〜100人で指定してください");
  }
  const cities = arr(body.cities);
  if (cities.length > MAX_AI_CITIES) throw new AiInputError(`AI旅行相談の訪問地は最大${MAX_AI_CITIES}都市までです`);
  return {
    area: str(body.area).slice(0, 120),
    startDate: str(body.start_date),
    endDate: str(body.end_date),
    note: str(body.note).slice(0, 200),
    people: peopleValue,
    selectedCandidateIds: strArr(body.selected_candidate_ids).slice(0, MAX_AI_CITIES * 3)
      .map((value) => value.slice(0, 80)),
    consultationToken: str(body.consultation_token).slice(0, 16_000),
    preferences: {
      pace,
      walking,
      transport,
      interests: strArr(rawPreferences.interests).slice(0, 8).map((value) => value.slice(0, 40)),
      extra: str(rawPreferences.extra).slice(0, 200),
    },
    cities: cities.map((city) => ({
      name: str(city.name).slice(0, 100),
      from_date: str(city.from_date),
      to_date: str(city.to_date),
    })),
  };
}

const finiteOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function itineraryRefineInput(body: Body): ItineraryRefineInput {
  const instruction = str(body.instruction).trim().slice(0, 1_200);
  if (!instruction) throw new AiInputError("変更したい内容を入力してください");
  const planId = str(body.plan_id).trim();
  if (!/^[\w-]{1,32}$/.test(planId)) throw new AiInputError("旅行計画を確認できませんでした");
  const history = arr(body.history).slice(-6).flatMap((message) => {
    const role = str(message.role);
    const content = str(message.content).trim().slice(0, 600);
    return (role === "user" || role === "assistant") && content
      ? [{ role: role as "user" | "assistant", content }]
      : [];
  });
  const currentItinerary = arr(body.current_itinerary).slice(0, 168).map((item): ItineraryRefineItem => {
    const rawKind = str(item.kind) as ItineraryKind;
    const kind = ITINERARY_KINDS.has(rawKind) ? rawKind : "sight";
    return {
      date: str(item.date).slice(0, 10),
      time: str(item.time).slice(0, 5),
      kind,
      city: str(item.city).slice(0, 100),
      title: str(item.title).slice(0, 160),
      place: str(item.place).slice(0, 160),
      address: str(item.address).slice(0, 240),
      latitude: finiteOrNull(item.latitude),
      longitude: finiteOrNull(item.longitude),
      note: str(item.note).slice(0, 300),
      from_city: str(item.from_city).slice(0, 100),
      from_place: str(item.from_place).slice(0, 160),
      from_address: str(item.from_address).slice(0, 240),
      from_latitude: finiteOrNull(item.from_latitude),
      from_longitude: finiteOrNull(item.from_longitude),
      to_city: str(item.to_city).slice(0, 100),
      to_place: str(item.to_place).slice(0, 160),
      to_address: str(item.to_address).slice(0, 240),
      to_latitude: finiteOrNull(item.to_latitude),
      to_longitude: finiteOrNull(item.to_longitude),
      transport: str(item.transport).slice(0, 40),
      duration_minutes: Math.max(0, Math.min(1440, Math.round(Number(item.duration_minutes) || 0))),
    };
  });
  return {
    plan_id: planId,
    start_date: str(body.start_date).slice(0, 10),
    end_date: str(body.end_date).slice(0, 10),
    active_date: str(body.active_date).slice(0, 10),
    instruction,
    history,
    current_itinerary: currentItinerary,
  };
}

function aiFailure(error: unknown): Handled {
  const detail = error instanceof AiUpstreamError ? error.causeDetail : error instanceof Error ? error.stack : String(error);
  console.error("[travel-ai] request failed", JSON.stringify({
    code: error instanceof AiUpstreamError || error instanceof AiOutputError ||
      error instanceof AiInputError || error instanceof AiUnavailableError ? error.code : "ai_internal_error",
    request_id: error instanceof AiUpstreamError ? error.requestId : "",
    retryable: error instanceof AiUpstreamError ? error.retryable : false,
    detail,
  }));
  if (error instanceof AiInputError) {
    return { status: 400, body: { error: error.code, message: error.message, retryable: false, action: error.action } };
  }
  if (error instanceof AiUnavailableError) {
    return {
      status: 503,
      body: { error: error.code, message: error.message, retryable: false, action: error.action },
    };
  }
  if (error instanceof AiUpstreamError) {
    const status = error.code === "ai_rate_limited"
      ? 429
      : error.code === "ai_timeout"
        ? 504
        : ["ai_authentication_failed", "ai_access_denied", "ai_model_unavailable", "ai_quota_exceeded"].includes(error.code)
          ? 503
          : ["ai_refused", "ai_content_filtered", "ai_input_too_large", "ai_output_too_long"].includes(error.code)
            ? 422
            : 502;
    return {
      status,
      body: {
        error: error.code,
        message: error.message,
        retryable: error.retryable,
        retry_after: error.retryAfter,
        action: error.action,
        request_id: error.requestId,
      },
    };
  }
  if (error instanceof AiOutputError) {
    return {
      // AI自体への接続は成功しており、返された内容を旅行として受理できない状態。
      // 502にするとCloudflareが上流障害ページへ差し替え、CORSとJSON契約が
      // ブラウザへ届かないことがあるため、意味どおり422で返す。
      status: 422,
      body: {
        error: error.code,
        message: "AIの行程が不完全だったため適用しませんでした。もう一度お試しください。",
        retryable: true,
        action: error.action,
      },
    };
  }
  return {
    status: 500,
    body: {
      error: "ai_internal_error",
      message: "AI旅行相談で予期しないエラーが発生しました。管理者へお知らせください。",
      retryable: false,
      action: "contact_support",
    },
  };
}

async function reserveAi(userId: string, scope: AiScope): Promise<Handled | null> {
  const reservation = await reserveAiRequest(userId, scope);
  return reservation.allowed
    ? null
    : {
      status: 429,
      body: {
        error: reservation.reason === "daily" ? "ai_daily_limit" : "ai_cooldown",
        message: reservation.reason === "daily"
          ? "本日のAI利用上限に達しました。翌日以降にもう一度お試しください。"
          : "短時間に続けてAIを利用しています。表示された時間を待ってお試しください。",
        retryable: true,
        retry_after: reservation.retryAfter,
        action: "retry_later",
      },
    };
}

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
  m = /^\/api\/plans\/([\w-]{1,32})\/placeholder-members$/.exec(path);
  if (m && method === "POST") {
    const denied = await forbiddenUnless(accessRepo.canManagePlan(m[1], actorUserId));
    if (denied) return denied;
    return {
      status: 200,
      body: await memberRepo.createPlaceholderMember(m[1], str(body.display_name), actorUserId),
    };
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
    await memberRepo.replaceMembers(
      m[1],
      arr(body.members) as { user_id: string; role?: string; from_date?: string | null; to_date?: string | null }[],
      actorUserId,
    );
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
    return {
      status: 200,
      body: await inviteRepo.acceptInvite(str(body.token), actorUserId, str(body.member_user_id)),
    };
  }
  if (method === "POST" && path === "/api/invites/inspect") {
    return { status: 200, body: await inviteRepo.inspectInvite(str(body.token)) };
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

  // ---- 外部ログインの紐付け ----
  if (method === "DELETE" && path === "/api/auth/line/link") {
    if (!actorUserId) return { status: 401, body: { error: "session_required" } };
    try {
      await unlinkLine(actorUserId);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      // 業務上の理由（他のログイン手段が無い等）だけ400で説明する。
      // DB障害などの生エラーは server.ts の分類に任せ、画面へ漏らさない。
      if (!(error instanceof BadRequest)) throw error;
      return { status: 400, body: { error: "bad_request", message: error.message } };
    }
  }

  // ---- AI（候補選択 → 旅程確定の2回で終了） ----
  if (method === "POST" && path === "/api/ai/itinerary-options") {
    if (!actorUserId) return { status: 401, body: { error: "session_required" } };
    try {
      const input = itineraryInput(body);
      const limited = await reserveAi(actorUserId, "options");
      if (limited) return limited;
      return { status: 200, body: await suggestItineraryOptions(actorUserId, input) };
    } catch (error) {
      return aiFailure(error);
    }
  }
  if (method === "POST" && path === "/api/ai/itinerary") {
    // キーはサーバーにしか無い。誰でも叩けると費用が伸びるのでログイン必須。
    if (!actorUserId) return { status: 401, body: { error: "session_required" } };
    try {
      const input = itineraryInput(body);
      const limited = await reserveAi(actorUserId, "itinerary");
      if (limited) return limited;
      const draft = await generateItinerary(actorUserId, input);
      return { status: 200, body: draft };
    } catch (error) {
      return aiFailure(error);
    }
  }
  if (method === "POST" && path === "/api/ai/itinerary-refine") {
    if (!actorUserId) return { status: 401, body: { error: "session_required" } };
    try {
      const input = itineraryRefineInput(body);
      // 閲覧者や公開共同編集者が他人の計画を材料にAI費用を使わないよう、
      // 正式な owner / editor メンバーだけに限定する。
      const access = await accessRepo.getPlanAccess(input.plan_id, actorUserId);
      if (!access.canEditWorkspace) return { status: 403, body: { error: "forbidden" } };
      const limited = await reserveAi(actorUserId, "itinerary");
      if (limited) return limited;
      return { status: 200, body: await refineItinerary(actorUserId, input) };
    } catch (error) {
      return aiFailure(error);
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
