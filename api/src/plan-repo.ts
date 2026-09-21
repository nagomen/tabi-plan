// 計画メタデータ・本文・閲覧数の永続化。
//
// 方針:
//   - 行程やチェックリストなどエディタが文書ごと保存する種類は一括置換にする。
//   - bootstrap、認証、認可、招待、メンバー、ユーザー、費用は各専用repositoryへ分離する。

import mysql from "mysql2/promise";
import { boundedNumber, safeDate } from "./coerce.js";
import { all, firstRow, pool, withTransaction } from "./db.js";
import { BadRequest, VersionConflict } from "./errors.js";
import { newId } from "./ids.js";
import {
  PLAN_CREATE_FIELDS, PLAN_EDIT_FIELDS, PLAN_MANAGE_FIELDS, planFieldError,
} from "./plan-contract.js";
import { safeUrl } from "./repo-helpers.js";

// ---- 計画 ---------------------------------------------------------------

export async function createPlan(input: Record<string, unknown>): Promise<{ id: string }> {
  const fieldError = planFieldError(input);
  if (fieldError) throw new BadRequest(fieldError);
  if (String(input.status || "draft") === "published") {
    throw new BadRequest("計画は下書きで作成し、旅行名・期間・訪問地を設定してから公開してください");
  }
  // idはURLパスの照合（[\w-]{1,32}）に使うため、クライアント指定値も同じ形式に限る。
  const id = String(input.id || newId("pln"));
  if (!/^[\w-]{1,32}$/.test(id)) throw new BadRequest("id の形式が正しくありません");
  const cols: string[] = ["id"];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(input)) {
    if (!PLAN_CREATE_FIELDS.has(k)) continue;
    cols.push(k);
    vals.push(v === "" ? null : v);
  }
  if (!cols.includes("slug") || !cols.includes("title")) throw new BadRequest("slug と title が必要です");
  await withTransaction(async (conn) => {
    await conn.query(`INSERT INTO plans (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    const owner = String(input.owner_user_id || "");
    if (owner) {
      await conn.query(
        `INSERT INTO plan_members (plan_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')
         ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
        [id, owner],
      );
      await conn.query(
        `INSERT INTO plan_access_grants (plan_id, user_id, role, status, granted_by_id)
         VALUES (?, ?, 'owner', 'active', ?)
         ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
        [id, owner, owner],
      );
    }
    if (Object.prototype.hasOwnProperty.call(input, "members")) {
      if (!Array.isArray(input.members)) throw new BadRequest("members は配列で指定してください");
      if (!owner) throw new BadRequest("計画のownerが必要です");
      const byUser = new Map<string, {
        user_id: string; role: "owner" | "editor" | "viewer"; from_date: string | null; to_date: string | null;
      }>();
      byUser.set(owner, { user_id: owner, role: "owner", from_date: null, to_date: null });
      for (const raw of input.members) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new BadRequest("members の各要素はオブジェクトで指定してください");
        const member = raw as Record<string, unknown>;
        const userId = String(member.user_id || "").trim();
        if (!/^[\w-]{1,32}$/.test(userId)) throw new BadRequest("メンバーIDの形式が正しくありません");
        if (userId === owner) continue;
        const fromDate = member.from_date ? safeDate(member.from_date) : null;
        const toDate = member.to_date ? safeDate(member.to_date) : null;
        if ((member.from_date && !fromDate) || (member.to_date && !toDate)) {
          throw new BadRequest("メンバーの参加日が正しくありません");
        }
        if (fromDate && toDate && fromDate > toDate) throw new BadRequest("参加開始日は参加終了日以前にしてください");
        byUser.set(userId, {
          user_id: userId,
          role: member.role === "viewer" ? "viewer" : "editor",
          from_date: fromDate,
          to_date: toDate,
        });
      }
      const initialMembers = [...byUser.values()];
      if (initialMembers.length > 100) throw new BadRequest("旅行メンバーは100人以内にしてください");
      const planStart = safeDate(input.start_date);
      const planEnd = safeDate(input.end_date);
      for (const member of initialMembers) {
        if (planStart && member.from_date && member.from_date < planStart) throw new BadRequest("参加開始日は旅行開始日以降にしてください");
        if (planEnd && member.from_date && member.from_date > planEnd) throw new BadRequest("参加開始日は旅行終了日以前にしてください");
        if (planStart && member.to_date && member.to_date < planStart) throw new BadRequest("参加終了日は旅行開始日以降にしてください");
        if (planEnd && member.to_date && member.to_date > planEnd) throw new BadRequest("参加終了日は旅行終了日以前にしてください");
      }
      const placeholders = initialMembers.map(() => "?").join(",");
      const [knownRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT id FROM users WHERE id IN (${placeholders}) FOR UPDATE`,
        initialMembers.map((member) => member.user_id),
      );
      if (knownRows.length !== initialMembers.length) throw new BadRequest("存在しないユーザーがメンバーに含まれています");
      await conn.query(
        `INSERT INTO plan_members (plan_id, user_id, role, status, from_date, to_date) VALUES ?
         ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active',
           from_date = VALUES(from_date), to_date = VALUES(to_date)`,
        [initialMembers.map((member) => [id, member.user_id, member.role, "active", member.from_date, member.to_date])],
      );
    }
    if (Object.prototype.hasOwnProperty.call(input, "content")) {
      if (!input.content || typeof input.content !== "object" || Array.isArray(input.content)) {
        throw new BadRequest("content はオブジェクトで指定してください");
      }
      await replacePlanContent(
        id,
        input.content as Parameters<typeof replacePlanContent>[1],
        1,
        owner,
        conn,
        false,
      );
    }
  });
  return { id };
}

export async function updatePlan(
  id: string,
  input: Record<string, unknown>,
  scope: "edit" | "manage",
  expectedVersion: number,
  actorUserId: string,
): Promise<number> {
  const fieldError = planFieldError(input);
  if (fieldError) throw new BadRequest(fieldError);
  const publishRelevant = ["status", "title", "start_date", "end_date"].some((key) =>
    Object.prototype.hasOwnProperty.call(input, key)
  );
  if (publishRelevant) {
    const rows = await all<{
      title: string; start_date: string | null; end_date: string | null; status: "draft" | "published"; city_count: number;
    }>(
      `SELECT p.title, p.start_date, p.end_date, p.status,
              (SELECT COUNT(*) FROM plan_cities c WHERE c.plan_id = p.id) AS city_count
         FROM plans p WHERE p.id = ? AND p.deleted_at IS NULL LIMIT 1`,
      [id],
    );
    const current = rows[0];
    if (!current) throw new BadRequest("計画が見つかりません");
    const targetStatus = String(input.status ?? current.status);
    const title = String(input.title ?? current.title ?? "").trim();
    const startDate = String(input.start_date ?? current.start_date ?? "");
    const endDate = String(input.end_date ?? current.end_date ?? "");
    if (startDate && endDate && endDate < startDate) {
      throw new BadRequest("旅行開始日は旅行終了日以前にしてください");
    }
    if (targetStatus === "published" && (
      !title || !/^\d{4}-\d{2}-\d{2}/.test(startDate) || !/^\d{4}-\d{2}-\d{2}/.test(endDate) || endDate < startDate
    )) {
      throw new BadRequest("公開には旅行名と正しい旅行期間が必要です");
    }
    if (targetStatus === "published" && Number(current.city_count) < 1) {
      throw new BadRequest("公開には訪問地が1つ以上必要です");
    }
  }
  const allowedFields = scope === "manage"
    ? new Set([...PLAN_EDIT_FIELDS, ...PLAN_MANAGE_FIELDS])
    : PLAN_EDIT_FIELDS;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!allowedFields.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v === "" ? null : v);
  }
  const accessSql = scope === "manage"
    ? "owner_user_id = ?"
    : `(owner_user_id = ? OR EXISTS (SELECT 1 FROM plan_access_grants pag
        WHERE pag.plan_id = plans.id AND pag.user_id = ? AND pag.status = 'active' AND pag.role IN ('owner','editor')))`;
  if (!sets.length) {
    const rows = await all<{ version: number }>(
      `SELECT version FROM plans WHERE id = ? AND deleted_at IS NULL AND source <> 'sample' AND (${accessSql}) LIMIT 1`,
      scope === "manage" ? [id, actorUserId] : [id, actorUserId, actorUserId],
    );
    if (!rows.length) throw new BadRequest("この計画を変更する権限がありません");
    const currentVersion = Number(rows[0]?.version || 0);
    // 変更対象が無くても、期待版がずれていれば衝突として伝える（黙って成功にしない）。
    if (currentVersion !== expectedVersion) {
      throw new VersionConflict("計画が別の端末で更新されています", currentVersion);
    }
    return currentVersion;
  }
  sets.push("version = version + 1");
  vals.push(id);
  vals.push(actorUserId);
  if (scope === "edit") vals.push(actorUserId);
  let sql = `UPDATE plans SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL
    AND source <> 'sample' AND (${accessSql})`;
  sql += " AND version = ?";
  vals.push(expectedVersion);
  const [result] = await pool.query<mysql.ResultSetHeader>(sql, vals);
  if (result.affectedRows !== 1) {
    // 「消えた計画」「権限喪失」「別端末の更新」を区別する。前2つを409にすると、
    // 画面が読み込み直しを繰り返しても直らない案内を出してしまう。
    const rows = await all<{ version: number }>(
      "SELECT version FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1", [id],
    );
    if (!rows.length) throw new BadRequest("計画が見つかりません");
    const permitted = await all<{ id: string }>(
      `SELECT id FROM plans WHERE id = ? AND deleted_at IS NULL AND source <> 'sample' AND (${accessSql}) LIMIT 1`,
      scope === "manage" ? [id, actorUserId] : [id, actorUserId, actorUserId],
    );
    if (!permitted.length) throw new BadRequest("この計画を変更する権限がありません");
    throw new VersionConflict("計画が別の端末で更新されています", Number(rows[0]?.version || 0));
  }
  return expectedVersion + 1;
}

export async function deletePlan(id: string, actorUserId: string): Promise<void> {
  const [result] = await pool.query<mysql.ResultSetHeader>(
    `UPDATE plans SET deleted_at = CURRENT_TIMESTAMP, version = version + 1
      WHERE id = ? AND deleted_at IS NULL AND source <> 'sample' AND owner_user_id = ?`,
    [id, actorUserId],
  );
  if (result.affectedRows !== 1) throw new BadRequest("削除できる計画が見つからないか、ownerではありません");
}

const CONTENT_COLLECTION_LIMITS: Record<string, number> = {
  itinerary: 1000,
  cities: 100,
  links: 100,
  checklist: 500,
  candidates: 500,
};
const ITINERARY_KINDS = new Set(["sight", "move", "food", "stay", "todo", "form"]);
const CHECKLIST_STATUSES = new Set(["todo", "doing", "done"]);
const CONTENT_ITEM_FIELDS = {
  itinerary: new Set([
    "item_date", "day_index", "kind", "start_time", "title", "place", "area", "note", "map_query",
    "lat", "lng", "from_place", "from_lat", "from_lng", "to_place", "to_lat", "to_lng", "transport",
    "duration_minutes", "member_ids",
  ]),
  cities: new Set(["name", "from_date", "to_date", "lat", "lng"]),
  links: new Set(["link_key", "label", "url", "caption"]),
  checklist: new Set(["label", "status"]),
  candidates: new Set([
    "id", "title", "place", "proposed_by_id", "adopted", "votes",
    "slot_id", "item_date", "start_time", "kind", "duration_minutes", "lat", "lng", "note", "member_ids",
  ]),
};

function assertLength(value: unknown, maximum: number, label: string): void {
  if (String(value || "").length > maximum) throw new BadRequest(`${label}は${maximum}文字以内にしてください`);
}

function assertOptionalDate(value: unknown, label: string): void {
  if (value !== null && value !== undefined && value !== "" && !safeDate(value)) {
    throw new BadRequest(`${label}の日付が正しくありません`);
  }
}

function assertOptionalNumber(value: unknown, minimum: number, maximum: number, label: string): void {
  if (value === null || value === undefined || value === "") return;
  if (boundedNumber(value, minimum, maximum) === null) {
    throw new BadRequest(`${label}は${minimum}〜${maximum}の数値で指定してください`);
  }
}

function assertKnownFields(item: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(item).filter((key) => !allowed.has(key));
  if (unknown.length) throw new BadRequest(`${label}に更新できない項目があります: ${unknown.join(", ")}`);
}

/** 全削除を始める前に本文全体を検査し、どの行が不正かを利用者へ返す。 */
export function validatePlanContent(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !Object.prototype.hasOwnProperty.call(CONTENT_COLLECTION_LIMITS, key));
  if (unknown.length) throw new BadRequest(`content に更新できない項目があります: ${unknown.join(", ")}`);
  for (const [key, limit] of Object.entries(CONTENT_COLLECTION_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key];
    if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new BadRequest(`${key} はオブジェクトの配列で指定してください`);
    }
    if (value.length > limit) throw new BadRequest(`${key} は${limit}件以内にしてください`);
  }

  ((body.itinerary || []) as Record<string, unknown>[]).forEach((item, index) => {
    const row = `行程${index + 1}件目の`;
    assertKnownFields(item, CONTENT_ITEM_FIELDS.itinerary, `行程${index + 1}件目`);
    const kind = String(item.kind || "sight");
    if (!ITINERARY_KINDS.has(kind)) throw new BadRequest(`${row}種別が正しくありません`);
    assertOptionalDate(item.item_date, `${row}日付`);
    assertOptionalNumber(item.day_index, 0, 1000, `${row}日番号`);
    if (item.start_time !== null && item.start_time !== undefined && item.start_time !== "" &&
        !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(item.start_time))) {
      throw new BadRequest(`${row}時刻が正しくありません`);
    }
    assertLength(item.title, 200, `${row}タイトル`);
    assertLength(item.place, 200, `${row}場所`);
    assertLength(item.area, 100, `${row}エリア`);
    assertLength(item.note, 5000, `${row}メモ`);
    assertLength(item.map_query, 200, `${row}地図検索語`);
    assertLength(item.from_place, 200, `${row}出発地`);
    assertLength(item.to_place, 200, `${row}到着地`);
    assertLength(item.transport, 60, `${row}移動手段`);
    for (const [field, min, max, label] of [
      ["lat", -90, 90, "緯度"], ["lng", -180, 180, "経度"],
      ["from_lat", -90, 90, "出発地の緯度"], ["from_lng", -180, 180, "出発地の経度"],
      ["to_lat", -90, 90, "到着地の緯度"], ["to_lng", -180, 180, "到着地の経度"],
      ["duration_minutes", 0, 65_535, "所要時間"],
    ] as const) assertOptionalNumber(item[field], min, max, `${row}${label}`);
    if (item.member_ids !== null && item.member_ids !== undefined) {
      if (!Array.isArray(item.member_ids) || item.member_ids.length > 50 ||
          item.member_ids.some((id) => typeof id !== "string" || !/^[\w-]{1,32}$/.test(id))) {
        throw new BadRequest(`${row}対象メンバーが正しくありません`);
      }
    }
  });

  ((body.cities || []) as Record<string, unknown>[]).forEach((city, index) => {
    const row = `訪問地${index + 1}件目の`;
    assertKnownFields(city, CONTENT_ITEM_FIELDS.cities, `訪問地${index + 1}件目`);
    const name = String(city.name || "").trim();
    if (!name) throw new BadRequest(`${row}名前を入力してください`);
    assertLength(name, 100, `${row}名前`);
    assertOptionalDate(city.from_date, `${row}開始日`);
    assertOptionalDate(city.to_date, `${row}終了日`);
    const from = safeDate(city.from_date);
    const to = safeDate(city.to_date);
    if (from && to && from > to) throw new BadRequest(`${row}開始日は終了日以前にしてください`);
    assertOptionalNumber(city.lat, -90, 90, `${row}緯度`);
    assertOptionalNumber(city.lng, -180, 180, `${row}経度`);
  });

  ((body.links || []) as Record<string, unknown>[]).forEach((link, index) => {
    const row = `リンク${index + 1}件目の`;
    assertKnownFields(link, CONTENT_ITEM_FIELDS.links, `リンク${index + 1}件目`);
    assertLength(link.link_key, 40, `${row}キー`);
    assertLength(link.label, 80, `${row}表示名`);
    assertLength(link.caption, 80, `${row}説明`);
    if (link.url && !safeUrl(link.url)) throw new BadRequest(`${row}URLが正しくありません`);
  });
  ((body.checklist || []) as Record<string, unknown>[]).forEach((item, index) => {
    assertKnownFields(item, CONTENT_ITEM_FIELDS.checklist, `チェックリスト${index + 1}件目`);
    if (!String(item.label || "").trim()) throw new BadRequest(`チェックリスト${index + 1}件目の内容を入力してください`);
    assertLength(item.label, 200, `チェックリスト${index + 1}件目の内容`);
    if (item.status !== undefined && !CHECKLIST_STATUSES.has(String(item.status))) {
      throw new BadRequest(`チェックリスト${index + 1}件目の状態が正しくありません`);
    }
  });
  ((body.candidates || []) as Record<string, unknown>[]).forEach((candidate, index) => {
    assertKnownFields(candidate, CONTENT_ITEM_FIELDS.candidates, `候補${index + 1}件目`);
    if (!String(candidate.title || "").trim()) throw new BadRequest(`候補${index + 1}件目のタイトルを入力してください`);
    assertLength(candidate.title, 200, `候補${index + 1}件目のタイトル`);
    assertLength(candidate.place, 200, `候補${index + 1}件目の場所`);
    assertLength(candidate.note, 5000, `候補${index + 1}件目のメモ`);
    if (candidate.id && !/^[\w-]{1,32}$/.test(String(candidate.id))) {
      throw new BadRequest(`候補${index + 1}件目のIDが正しくありません`);
    }
    if (candidate.slot_id && !/^[\w-]{1,32}$/.test(String(candidate.slot_id))) {
      throw new BadRequest(`候補${index + 1}件目の投票枠IDが正しくありません`);
    }
    assertOptionalDate(candidate.item_date, `候補${index + 1}件目の日付`);
    if (candidate.start_time !== null && candidate.start_time !== undefined && candidate.start_time !== "" &&
        !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(candidate.start_time))) {
      throw new BadRequest(`候補${index + 1}件目の時刻が正しくありません`);
    }
    if (candidate.kind !== null && candidate.kind !== undefined && candidate.kind !== "" &&
        !ITINERARY_KINDS.has(String(candidate.kind))) {
      throw new BadRequest(`候補${index + 1}件目の種別が正しくありません`);
    }
    assertOptionalNumber(candidate.duration_minutes, 0, 65_535, `候補${index + 1}件目の所要時間`);
    assertOptionalNumber(candidate.lat, -90, 90, `候補${index + 1}件目の緯度`);
    assertOptionalNumber(candidate.lng, -180, 180, `候補${index + 1}件目の経度`);
    if (candidate.member_ids !== null && candidate.member_ids !== undefined &&
        (!Array.isArray(candidate.member_ids) || candidate.member_ids.length > 50 ||
          candidate.member_ids.some((id) => typeof id !== "string" || !/^[\w-]{1,32}$/.test(id)))) {
      throw new BadRequest(`候補${index + 1}件目の対象メンバーが正しくありません`);
    }
    if (candidate.votes !== undefined && (!Array.isArray(candidate.votes) || candidate.votes.length > 100 ||
        candidate.votes.some((id) => typeof id !== "string" || !/^[\w-]{1,32}$/.test(id)))) {
      throw new BadRequest(`候補${index + 1}件目の投票者が正しくありません`);
    }
  });
  const slotShapes = new Map<string, string>();
  ((body.candidates || []) as Record<string, unknown>[]).forEach((candidate, index) => {
    const slotId = String(candidate.slot_id || "");
    if (!slotId) return;
    const members = Array.isArray(candidate.member_ids)
      ? [...new Set(candidate.member_ids.map(String))].sort()
      : [];
    const shape = JSON.stringify({
      date: candidate.item_date || null,
      time: candidate.start_time || null,
      kind: candidate.kind || null,
      duration: candidate.duration_minutes ?? null,
      members,
    });
    const previous = slotShapes.get(slotId);
    if (previous && previous !== shape) {
      throw new BadRequest(`候補${index + 1}件目の日時または対象メンバーが同じ投票枠の他候補と一致しません`);
    }
    slotShapes.set(slotId, shape);
  });
}

/** 計画本文（行程・都市・リンク・チェックリスト・候補）を一括置換する。 */
export async function replacePlanContent(planId: string, body: {
  itinerary?: Record<string, unknown>[];
  cities?: { name: string; from_date?: string | null; to_date?: string | null; lat?: number | null; lng?: number | null }[];
  links?: Record<string, unknown>[];
  checklist?: { label: string; status?: string }[];
  candidates?: {
    id?: string; title: string; place?: string | null; proposed_by_id?: string | null; adopted?: boolean; votes?: string[];
    slot_id?: string | null; item_date?: string | null; start_time?: string | null; kind?: string | null;
    duration_minutes?: number | null; lat?: number | null; lng?: number | null; note?: string | null; member_ids?: string[] | null;
  }[];
  }, expectedVersion: number, actorUserId: string, existingConnection?: mysql.PoolConnection,
  incrementVersion = true): Promise<number> {
  const work = async (conn: mysql.PoolConnection): Promise<number> => {
    validatePlanContent(body as Record<string, unknown>);
    const planRow = await firstRow<{
      version: number; source: string; visibility: string; status: string; open_editing: number;
    }>(
      conn,
      `SELECT version, source, visibility, status, open_editing
         FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
      [planId],
    );
    if (!planRow) throw new BadRequest("計画が見つかりません");
    const currentVersion = Number(planRow.version || 0);
    const actorMember = actorUserId ? await firstRow<{ role: string }>(
      conn,
      `SELECT role FROM plan_access_grants
        WHERE plan_id = ? AND user_id = ? AND status = 'active' LIMIT 1 FOR UPDATE`,
      [planId, actorUserId],
    ) : null;
    const workspaceEditor = actorMember?.role === "owner" || actorMember?.role === "editor";
    if (planRow.source === "sample" || !workspaceEditor) {
      throw new BadRequest("この計画を変更する権限がありません");
    }
    if (currentVersion !== expectedVersion) {
      throw new VersionConflict("計画が別の端末で更新されています", currentVersion);
    }

    const requestedMemberIds = new Set<string>();
    for (const item of body.itinerary || []) {
      if (Array.isArray(item.member_ids)) {
        for (const userId of item.member_ids) requestedMemberIds.add(String(userId));
      }
    }
    for (const candidate of body.candidates || []) {
      if (Array.isArray(candidate.member_ids)) {
        for (const userId of candidate.member_ids) requestedMemberIds.add(String(userId));
      }
    }
    if (requestedMemberIds.size) {
      const placeholders = [...requestedMemberIds].map(() => "?").join(",");
      const [memberRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT user_id FROM plan_members
          WHERE plan_id = ? AND status = 'active' AND user_id IN (${placeholders}) FOR UPDATE`,
        [planId, ...requestedMemberIds],
      );
      if (memberRows.length !== requestedMemberIds.size) {
        throw new BadRequest("行程の対象メンバーには、この旅行の有効な参加者だけを指定してください");
      }
    }

    if (body.cities) {
      const status = String(planRow.status || "draft");
      if (status === "published" && !body.cities.some((city) => String(city?.name || "").trim())) {
        throw new BadRequest("公開中の計画には訪問地が1つ以上必要です。先に下書きへ戻してください");
      }
    }

    if (body.itinerary) {
      await conn.query("DELETE FROM itinerary_items WHERE plan_id = ?", [planId]);
      // 日付・時刻・座標・分数は、DBの厳格モードで500になる前に安全な値へ丸める。
      const timeOrNull = (v: unknown): string | null =>
        /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(v || "")) ? String(v) : null;
      // 対象メンバー。user_id の配列だけ受け付け、それ以外や空は NULL（＝全員）に落とす。
      const memberIdsOrNull = (v: unknown): string | null => {
        if (!Array.isArray(v)) return null;
        const ids = [...new Set(v.filter((x) => typeof x === "string" && x && x.length <= 64))].slice(0, 50);
        return ids.length ? JSON.stringify(ids) : null;
      };
      const rows = body.itinerary.map((it, i) => [
        newId("itm"), planId, safeDate(it.item_date), boundedNumber(it.day_index, 0, 1000), i,
        it.kind || "sight", timeOrNull(it.start_time), String(it.title || "").slice(0, 200),
        it.place || null, it.area || null, it.note || null, it.map_query || null,
        boundedNumber(it.lat, -90, 90), boundedNumber(it.lng, -180, 180),
        it.from_place || null, boundedNumber(it.from_lat, -90, 90), boundedNumber(it.from_lng, -180, 180),
        it.to_place || null, boundedNumber(it.to_lat, -90, 90), boundedNumber(it.to_lng, -180, 180),
        it.transport || null, boundedNumber(it.duration_minutes, 0, 65_535),
        memberIdsOrNull(it.member_ids),
      ]);
      if (rows.length) {
        await conn.query(
          `INSERT INTO itinerary_items (id, plan_id, item_date, day_index, sort_order, kind, start_time,
             title, place, area, note, map_query, lat, lng, from_place, from_lat, from_lng,
             to_place, to_lat, to_lng, transport, duration_minutes, member_ids)
           VALUES ?`, [rows]);
      }
    }

    if (body.cities) {
      await conn.query("DELETE FROM plan_cities WHERE plan_id = ?", [planId]);
      const rows = body.cities.filter((c) => c && c.name).map((c, i) => [
        newId("cty"), planId, String(c.name).slice(0, 100), safeDate(c.from_date), safeDate(c.to_date),
        boundedNumber(c.lat, -90, 90), boundedNumber(c.lng, -180, 180), i,
      ]);
      if (rows.length) {
        await conn.query(
          "INSERT INTO plan_cities (id, plan_id, name, from_date, to_date, lat, lng, sort_order) VALUES ?",
          [rows],
        );
      }
    }

    if (body.links) {
      await conn.query("DELETE FROM plan_links WHERE plan_id = ?", [planId]);
      const seen = new Set<string>();
      const rows: unknown[][] = [];
      body.links.forEach((l, i) => {
        const key = String(l.link_key || `link${i}`).slice(0, 40);
        const url = safeUrl(l.url);
        if (!url || seen.has(key)) return;
        seen.add(key);
        rows.push([newId("lnk"), planId, key, String(l.label || key).slice(0, 80), url, l.caption || null, i]);
      });
      if (rows.length) await conn.query("INSERT INTO plan_links (id, plan_id, link_key, label, url, caption, sort_order) VALUES ?", [rows]);
    }

    if (body.checklist) {
      await conn.query("DELETE FROM plan_checklist_items WHERE plan_id = ?", [planId]);
      const rows = body.checklist.filter((c) => c && c.label)
        .map((c, i) => [newId("chk"), planId, String(c.label).slice(0, 200), c.status || "todo", i]);
      if (rows.length) await conn.query("INSERT INTO plan_checklist_items (id, plan_id, label, status, sort_order) VALUES ?", [rows]);
    }

    if (body.candidates) {
      if (!actorUserId) throw new BadRequest("候補を保存するにはログインが必要です");
      const [memberRows] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT user_id FROM plan_members WHERE plan_id = ? AND status = 'active' FOR UPDATE",
        [planId],
      );
      if (!(memberRows as unknown as { user_id: string }[]).some((row) => row.user_id === actorUserId)) {
        throw new BadRequest("旅行メンバーだけが候補を保存できます");
      }
      const [oldCandidateRows] = await conn.query<mysql.RowDataPacket[]>(
        "SELECT id, proposed_by_id FROM plan_candidates WHERE plan_id = ? FOR UPDATE",
        [planId],
      );
      const oldCandidates = new Map(
        (oldCandidateRows as unknown as { id: string; proposed_by_id: string | null }[])
          .map((row) => [row.id, row]),
      );
      const [oldVoteRows] = await conn.query<mysql.RowDataPacket[]>(
        `SELECT v.candidate_id, v.user_id FROM plan_candidate_votes v
          JOIN plan_candidates c ON c.id = v.candidate_id
         WHERE c.plan_id = ? FOR UPDATE`,
        [planId],
      );
      const oldVotes = new Map<string, Set<string>>();
      for (const row of oldVoteRows as unknown as { candidate_id: string; user_id: string }[]) {
        const voters = oldVotes.get(row.candidate_id) || new Set<string>();
        voters.add(row.user_id);
        oldVotes.set(row.candidate_id, voters);
      }
      await conn.query("DELETE FROM plan_candidates WHERE plan_id = ?", [planId]); // votes は CASCADE
      const candRows: unknown[][] = [];
      const voteRows: unknown[][] = [];
      for (const c of body.candidates) {
        if (!c || !c.title) continue;
        const cid = c.id && /^[\w-]{1,32}$/.test(c.id) ? c.id : newId("cnd");
        const old = oldCandidates.get(cid);
        const proposerId = old?.proposed_by_id || actorUserId;
        const memberIds = Array.isArray(c.member_ids)
          ? [...new Set(c.member_ids.filter((id) => typeof id === "string" && id))].slice(0, 50)
          : [];
        const startTime = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(c.start_time || ""))
          ? String(c.start_time)
          : null;
        candRows.push([
          cid, planId, String(c.title).slice(0, 200), c.place || null, proposerId,
          c.slot_id || null, safeDate(c.item_date), startTime,
          ITINERARY_KINDS.has(String(c.kind || "")) ? c.kind : null,
          boundedNumber(c.duration_minutes, 0, 65_535), boundedNumber(c.lat, -90, 90), boundedNumber(c.lng, -180, 180), c.note || null,
          memberIds.length ? JSON.stringify(memberIds) : null,
          c.adopted ? new Date() : null,
        ]);
        // 他人の票は現在値を保存し、操作本人の票だけを入力から反映する。
        const voters = new Set([...(oldVotes.get(cid) || [])].filter((uid) => uid !== actorUserId));
        if (new Set(c.votes || []).has(actorUserId)) voters.add(actorUserId);
        for (const uid of voters) voteRows.push([cid, uid]);
      }
      if (candRows.length) {
        await conn.query(
          `INSERT INTO plan_candidates (id, plan_id, title, place, proposed_by_id, slot_id, item_date,
             start_time, kind, duration_minutes, lat, lng, note, member_ids, adopted_at) VALUES ?`,
          [candRows],
        );
      }
      if (voteRows.length) {
        await conn.query("INSERT IGNORE INTO plan_candidate_votes (candidate_id, user_id) VALUES ?", [voteRows]);
      }
    }

    if (incrementVersion) {
      await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
    }
    return currentVersion + (incrementVersion ? 1 : 0);
  };
  return existingConnection ? work(existingConnection) : withTransaction(work);
}

export async function countView(planId: string): Promise<void> {
  await pool.query(
    `INSERT INTO plan_view_daily (plan_id, viewed_on, view_count) VALUES (?, CURRENT_DATE, 1)
     ON DUPLICATE KEY UPDATE view_count = view_count + 1`,
    [planId],
  );
}
