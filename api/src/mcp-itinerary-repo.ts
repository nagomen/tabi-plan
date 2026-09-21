import crypto from "node:crypto";
import type mysql from "mysql2/promise";
import { all, firstRow, pool, withTransaction } from "./db.js";
import { BadRequest, Forbidden, NotFound, VersionConflict } from "./errors.js";
import { newId } from "./ids.js";
import { TARGET_TRIP_SLUG } from "./mcp-constants.js";
import { validatePlanContent } from "./plan-repo.js";

export interface McpItineraryItem {
  id: string;
  item_date: string | null;
  day_index: number | null;
  sort_order: number;
  kind: string;
  start_time: string | null;
  title: string;
  place: string | null;
  area: string | null;
  note: string | null;
  map_query: string | null;
  lat: number | null;
  lng: number | null;
  from_place: string | null;
  from_lat: number | null;
  from_lng: number | null;
  to_place: string | null;
  to_lat: number | null;
  to_lng: number | null;
  transport: string | null;
  duration_minutes: number | null;
  member_ids: string[] | null;
}

export type ItineraryCreateInput = Omit<McpItineraryItem, "id" | "sort_order"> & {
  position?: number;
};

export type ItineraryPatch = Partial<Omit<ItineraryCreateInput, "item_date" | "position">>;

interface TargetPlan {
  id: string;
  title: string;
  version: number;
}

interface AuditRow {
  itinerary_item_id: string;
  before_json: string | McpItineraryItem;
  action?: "create" | "update" | "move" | "delete" | "restore";
}

const ITEM_COLUMNS = `id, item_date, day_index, sort_order, kind, start_time, title, place, area, note,
  map_query, lat, lng, from_place, from_lat, from_lng, to_place, to_lat, to_lng,
  transport, duration_minutes, member_ids`;

function parsedMemberIds(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === "string");
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : null;
  } catch {
    return null;
  }
}

function normalizedItem(row: Omit<McpItineraryItem, "member_ids"> & { member_ids: unknown }): McpItineraryItem {
  return {
    ...row,
    day_index: row.day_index === null ? null : Number(row.day_index),
    sort_order: Number(row.sort_order),
    lat: row.lat === null ? null : Number(row.lat),
    lng: row.lng === null ? null : Number(row.lng),
    from_lat: row.from_lat === null ? null : Number(row.from_lat),
    from_lng: row.from_lng === null ? null : Number(row.from_lng),
    to_lat: row.to_lat === null ? null : Number(row.to_lat),
    to_lng: row.to_lng === null ? null : Number(row.to_lng),
    duration_minutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    member_ids: parsedMemberIds(row.member_ids),
  };
}

function itemForValidation(input: ItineraryCreateInput | McpItineraryItem): Record<string, unknown> {
  return {
    item_date: input.item_date,
    day_index: input.day_index,
    kind: input.kind,
    start_time: input.start_time,
    title: input.title,
    place: input.place,
    area: input.area,
    note: input.note,
    map_query: input.map_query,
    lat: input.lat,
    lng: input.lng,
    from_place: input.from_place,
    from_lat: input.from_lat,
    from_lng: input.from_lng,
    to_place: input.to_place,
    to_lat: input.to_lat,
    to_lng: input.to_lng,
    transport: input.transport,
    duration_minutes: input.duration_minutes,
    member_ids: input.member_ids,
  };
}

export function validateMcpItineraryItem(input: ItineraryCreateInput | McpItineraryItem): void {
  if (!String(input.title || "").trim()) throw new BadRequest("行程のタイトルを入力してください");
  validatePlanContent({ itinerary: [itemForValidation(input)] });
}

function payloadHash(value: unknown): Buffer {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest();
}

async function targetPlanForEditor(
  executor: mysql.Pool | mysql.PoolConnection,
  actorUserId: string,
  lock = false,
): Promise<TargetPlan> {
  const plan = await firstRow<TargetPlan>(executor,
    `SELECT p.id, p.title, p.version
       FROM plans p JOIN plan_access_grants pag
         ON pag.plan_id = p.id AND pag.user_id = ?
      WHERE p.slug = ? AND p.deleted_at IS NULL AND p.source <> 'sample'
        AND pag.status = 'active' AND pag.role IN ('owner','editor')
      LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [actorUserId, TARGET_TRIP_SLUG],
  );
  if (!plan) throw new Forbidden("この旅行の旅程を編集する権限がありません");
  return { ...plan, version: Number(plan.version) };
}

function assertVersion(plan: TargetPlan, expectedVersion: number): void {
  if (plan.version !== expectedVersion) {
    throw new VersionConflict("計画が別の端末で更新されています", plan.version);
  }
}

async function assertActiveMembers(
  conn: mysql.PoolConnection,
  planId: string,
  memberIds: string[] | null,
): Promise<void> {
  if (!memberIds?.length) return;
  const unique = [...new Set(memberIds)];
  const placeholders = unique.map(() => "?").join(",");
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT user_id FROM plan_members
      WHERE plan_id = ? AND status = 'active' AND user_id IN (${placeholders}) FOR UPDATE`,
    [planId, ...unique],
  );
  if (rows.length !== unique.length) {
    throw new BadRequest("行程の対象メンバーには、この旅行の有効な参加者だけを指定してください");
  }
}

async function targetItem(
  conn: mysql.PoolConnection,
  planId: string,
  itemId: string,
): Promise<McpItineraryItem> {
  const row = await firstRow<Omit<McpItineraryItem, "member_ids"> & { member_ids: unknown }>(conn,
    `SELECT ${ITEM_COLUMNS} FROM itinerary_items
      WHERE id = ? AND plan_id = ? LIMIT 1 FOR UPDATE`,
    [itemId, planId],
  );
  if (!row) throw new NotFound("この旅行の行程項目が見つかりません");
  return normalizedItem(row);
}

async function orderedDateItems(
  conn: mysql.PoolConnection,
  planId: string,
  itemDate: string | null,
  exceptId = "",
): Promise<string[]> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT id FROM itinerary_items
      WHERE plan_id = ? AND item_date <=> ? ${exceptId ? "AND id <> ?" : ""}
      ORDER BY sort_order, start_time, id FOR UPDATE`,
    exceptId ? [planId, itemDate, exceptId] : [planId, itemDate],
  );
  return rows.map((row) => String(row.id));
}

async function saveOrder(conn: mysql.PoolConnection, ids: string[]): Promise<void> {
  for (let index = 0; index < ids.length; index += 1) {
    await conn.query("UPDATE itinerary_items SET sort_order = ? WHERE id = ?", [index, ids[index]]);
  }
}

function clampedPosition(position: number | undefined, length: number): number {
  if (position === undefined) return length;
  return Math.max(0, Math.min(Math.trunc(position), length));
}

async function insertSnapshot(
  conn: mysql.PoolConnection,
  planId: string,
  item: McpItineraryItem,
): Promise<void> {
  await conn.query(
    `INSERT INTO itinerary_items
       (id, plan_id, item_date, day_index, sort_order, kind, start_time, title, place, area, note,
        map_query, lat, lng, from_place, from_lat, from_lng, to_place, to_lat, to_lng,
        transport, duration_minutes, member_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      item.id, planId, item.item_date, item.day_index, item.sort_order, item.kind, item.start_time,
      item.title.trim(), item.place, item.area, item.note, item.map_query, item.lat, item.lng,
      item.from_place, item.from_lat, item.from_lng, item.to_place, item.to_lat, item.to_lng,
      item.transport, item.duration_minutes,
      item.member_ids?.length ? JSON.stringify([...new Set(item.member_ids)]) : null,
    ],
  );
}

async function audit(
  conn: mysql.PoolConnection,
  planId: string,
  itemId: string,
  actorUserId: string,
  action: "create" | "update" | "move" | "delete" | "restore",
  before: McpItineraryItem | null,
  after: McpItineraryItem | null,
): Promise<void> {
  await conn.query(
    `INSERT INTO itinerary_audit_logs
       (id, plan_id, itinerary_item_id, actor_user_id, action, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [newId("iau"), planId, itemId, actorUserId, action,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null],
  );
}

async function bumpVersion(conn: mysql.PoolConnection, planId: string): Promise<number> {
  await conn.query(
    "UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [planId],
  );
  const row = await firstRow<{ version: number }>(conn,
    "SELECT version FROM plans WHERE id = ? LIMIT 1", [planId]);
  return Number(row?.version || 0);
}

export async function loadTargetTripItinerary(actorUserId: string): Promise<{
  plan: TargetPlan;
  items: McpItineraryItem[];
}> {
  const plan = await targetPlanForEditor(pool, actorUserId);
  const rows = await all<Omit<McpItineraryItem, "member_ids"> & { member_ids: unknown }>(
    `SELECT ${ITEM_COLUMNS} FROM itinerary_items
      WHERE plan_id = ? ORDER BY item_date, sort_order, start_time, id`,
    [plan.id],
  );
  return { plan, items: rows.map(normalizedItem) };
}

export async function listDeletedTargetItinerary(actorUserId: string): Promise<{
  plan: TargetPlan;
  items: McpItineraryItem[];
}> {
  const plan = await targetPlanForEditor(pool, actorUserId);
  const rows = await all<AuditRow>(
    `SELECT a.itinerary_item_id, a.before_json
       FROM itinerary_audit_logs a
      WHERE a.plan_id = ? AND a.action = 'delete'
        AND NOT EXISTS (
          SELECT 1 FROM itinerary_audit_logs newer
           WHERE newer.plan_id = a.plan_id
             AND newer.itinerary_item_id = a.itinerary_item_id
             AND (newer.created_at > a.created_at
               OR (newer.created_at = a.created_at AND newer.id > a.id))
        )
      ORDER BY a.created_at DESC`,
    [plan.id],
  );
  return {
    plan,
    items: rows.map((row) => {
      const raw = typeof row.before_json === "string" ? JSON.parse(row.before_json) : row.before_json;
      return normalizedItem({ ...raw, member_ids: raw.member_ids });
    }),
  };
}

export async function createTargetItineraryItem(
  actorUserId: string,
  input: ItineraryCreateInput,
  expectedVersion: number,
  requestId: string,
): Promise<{ itemId: string; version: number; replayed: boolean }> {
  validateMcpItineraryItem(input);
  return withTransaction(async (conn) => {
    const plan = await targetPlanForEditor(conn, actorUserId, true);
    const hash = payloadHash({ input, expectedVersion });
    const existing = await firstRow<{ payload_hash: Buffer; itinerary_item_id: string }>(conn,
      `SELECT payload_hash, itinerary_item_id FROM mcp_itinerary_requests
        WHERE user_id = ? AND request_id = ? LIMIT 1 FOR UPDATE`,
      [actorUserId, requestId],
    );
    if (existing) {
      if (!crypto.timingSafeEqual(Buffer.from(existing.payload_hash), hash)) {
        throw new BadRequest("同じrequestIdが別の行程内容に使われています");
      }
      return { itemId: existing.itinerary_item_id, version: plan.version, replayed: true };
    }
    assertVersion(plan, expectedVersion);
    await assertActiveMembers(conn, plan.id, input.member_ids);
    const ids = await orderedDateItems(conn, plan.id, input.item_date);
    const position = clampedPosition(input.position, ids.length);
    const item: McpItineraryItem = {
      ...input,
      id: newId("itm"),
      sort_order: position,
      title: input.title.trim(),
    };
    delete (item as McpItineraryItem & { position?: number }).position;
    await insertSnapshot(conn, plan.id, item);
    ids.splice(position, 0, item.id);
    await saveOrder(conn, ids);
    const version = await bumpVersion(conn, plan.id);
    await audit(conn, plan.id, item.id, actorUserId, "create", null, item);
    await conn.query(
      `INSERT INTO mcp_itinerary_requests
         (user_id, request_id, plan_id, payload_hash, itinerary_item_id)
       VALUES (?, ?, ?, ?, ?)`,
      [actorUserId, requestId, plan.id, hash, item.id],
    );
    return { itemId: item.id, version, replayed: false };
  });
}

export async function updateTargetItineraryItem(
  actorUserId: string,
  itemId: string,
  patch: ItineraryPatch,
  expectedVersion: number,
): Promise<{ version: number }> {
  if (!Object.keys(patch).length) throw new BadRequest("変更する項目を指定してください");
  return withTransaction(async (conn) => {
    const plan = await targetPlanForEditor(conn, actorUserId, true);
    assertVersion(plan, expectedVersion);
    const current = await targetItem(conn, plan.id, itemId);
    const next = { ...current, ...patch, id: current.id, item_date: current.item_date, sort_order: current.sort_order };
    validateMcpItineraryItem(next);
    await assertActiveMembers(conn, plan.id, next.member_ids);
    await conn.query(
      `UPDATE itinerary_items SET day_index = ?, kind = ?, start_time = ?, title = ?, place = ?, area = ?,
         note = ?, map_query = ?, lat = ?, lng = ?, from_place = ?, from_lat = ?, from_lng = ?,
         to_place = ?, to_lat = ?, to_lng = ?, transport = ?, duration_minutes = ?, member_ids = ?
       WHERE id = ? AND plan_id = ?`,
      [
        next.day_index, next.kind, next.start_time, next.title.trim(), next.place, next.area, next.note,
        next.map_query, next.lat, next.lng, next.from_place, next.from_lat, next.from_lng,
        next.to_place, next.to_lat, next.to_lng, next.transport, next.duration_minutes,
        next.member_ids?.length ? JSON.stringify([...new Set(next.member_ids)]) : null,
        itemId, plan.id,
      ],
    );
    const after = await targetItem(conn, plan.id, itemId);
    const version = await bumpVersion(conn, plan.id);
    await audit(conn, plan.id, itemId, actorUserId, "update", current, after);
    return { version };
  });
}

export async function moveTargetItineraryItem(
  actorUserId: string,
  itemId: string,
  itemDate: string | null,
  position: number,
  expectedVersion: number,
): Promise<{ version: number }> {
  validatePlanContent({ itinerary: [{ title: "move", item_date: itemDate }] });
  return withTransaction(async (conn) => {
    const plan = await targetPlanForEditor(conn, actorUserId, true);
    assertVersion(plan, expectedVersion);
    const current = await targetItem(conn, plan.id, itemId);
    const oldIds = await orderedDateItems(conn, plan.id, current.item_date, itemId);
    const targetIds = current.item_date === itemDate
      ? oldIds
      : await orderedDateItems(conn, plan.id, itemDate, itemId);
    const targetPosition = clampedPosition(position, targetIds.length);
    targetIds.splice(targetPosition, 0, itemId);
    await conn.query("UPDATE itinerary_items SET item_date = ? WHERE id = ? AND plan_id = ?", [itemDate, itemId, plan.id]);
    if (current.item_date !== itemDate) await saveOrder(conn, oldIds);
    await saveOrder(conn, targetIds);
    const after = await targetItem(conn, plan.id, itemId);
    const version = await bumpVersion(conn, plan.id);
    await audit(conn, plan.id, itemId, actorUserId, "move", current, after);
    return { version };
  });
}

export async function deleteTargetItineraryItem(
  actorUserId: string,
  itemId: string,
  expectedVersion: number,
): Promise<{ version: number }> {
  return withTransaction(async (conn) => {
    const plan = await targetPlanForEditor(conn, actorUserId, true);
    assertVersion(plan, expectedVersion);
    const current = await targetItem(conn, plan.id, itemId);
    await conn.query("DELETE FROM itinerary_items WHERE id = ? AND plan_id = ?", [itemId, plan.id]);
    const ids = await orderedDateItems(conn, plan.id, current.item_date);
    await saveOrder(conn, ids);
    const version = await bumpVersion(conn, plan.id);
    await audit(conn, plan.id, itemId, actorUserId, "delete", current, null);
    return { version };
  });
}

export async function restoreTargetItineraryItem(
  actorUserId: string,
  itemId: string,
  expectedVersion: number,
): Promise<{ version: number }> {
  return withTransaction(async (conn) => {
    const plan = await targetPlanForEditor(conn, actorUserId, true);
    assertVersion(plan, expectedVersion);
    const existing = await firstRow<{ id: string }>(conn,
      "SELECT id FROM itinerary_items WHERE id = ? AND plan_id = ? LIMIT 1 FOR UPDATE", [itemId, plan.id]);
    if (existing) throw new BadRequest("この行程項目は既に復元されています");
    const deleted = await firstRow<AuditRow>(conn,
      `SELECT itinerary_item_id, before_json, action FROM itinerary_audit_logs
        WHERE plan_id = ? AND itinerary_item_id = ?
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [plan.id, itemId],
    );
    if (!deleted || deleted.action !== "delete") throw new NotFound("復元できる行程項目が見つかりません");
    const raw = typeof deleted.before_json === "string" ? JSON.parse(deleted.before_json) : deleted.before_json;
    const item = normalizedItem({ ...raw, member_ids: raw.member_ids });
    validateMcpItineraryItem(item);
    await assertActiveMembers(conn, plan.id, item.member_ids);
    const ids = await orderedDateItems(conn, plan.id, item.item_date);
    const position = clampedPosition(item.sort_order, ids.length);
    item.sort_order = position;
    await insertSnapshot(conn, plan.id, item);
    ids.splice(position, 0, item.id);
    await saveOrder(conn, ids);
    const after = await targetItem(conn, plan.id, item.id);
    const version = await bumpVersion(conn, plan.id);
    await audit(conn, plan.id, item.id, actorUserId, "restore", null, after);
    return { version };
  });
}
