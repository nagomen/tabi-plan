// 計画メタデータ・本文・閲覧数の永続化。
//
// 方針:
//   - 行程やチェックリストなどエディタが文書ごと保存する種類は一括置換にする。
//   - bootstrap、認証、認可、招待、メンバー、ユーザー、費用は各専用repositoryへ分離する。

import mysql from "mysql2/promise";
import { all, firstRow, pool, withTransaction } from "./db.js";
import { BadRequest, VersionConflict } from "./errors.js";
import { newId } from "./ids.js";
import {
  PLAN_COLLABORATE_FIELDS, PLAN_CREATE_FIELDS, PLAN_EDIT_FIELDS, PLAN_MANAGE_FIELDS, planFieldError,
} from "./plan-contract.js";
import { safeUrl } from "./repo-helpers.js";

// ---- 計画 ---------------------------------------------------------------

export async function createPlan(input: Record<string, unknown>): Promise<{ id: string }> {
  const fieldError = planFieldError(input);
  if (fieldError) throw new BadRequest(fieldError);
  if (String(input.status || "draft") === "published") {
    throw new BadRequest("計画は下書きで作成し、旅行名・期間・訪問地を設定してから公開してください");
  }
  const id = String(input.id || newId("pln"));
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
    }
  });
  return { id };
}

export async function updatePlan(
  id: string,
  input: Record<string, unknown>,
  scope: "collaborate" | "edit" | "manage" = "edit",
  expectedVersion?: number,
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
    : scope === "edit" ? PLAN_EDIT_FIELDS : PLAN_COLLABORATE_FIELDS;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!allowedFields.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v === "" ? null : v);
  }
  if (!sets.length) {
    const rows = await all<{ version: number }>("SELECT version FROM plans WHERE id = ? LIMIT 1", [id]);
    const currentVersion = Number(rows[0]?.version || 0);
    // 変更対象が無くても、期待版がずれていれば衝突として伝える（黙って成功にしない）。
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new VersionConflict("計画が別の端末で更新されています", currentVersion);
    }
    return currentVersion;
  }
  sets.push("version = version + 1");
  vals.push(id);
  let sql = `UPDATE plans SET ${sets.join(", ")} WHERE id = ? AND deleted_at IS NULL`;
  if (expectedVersion !== undefined) {
    sql += " AND version = ?";
    vals.push(expectedVersion);
  }
  const [result] = await pool.query<mysql.ResultSetHeader>(sql, vals);
  if (result.affectedRows !== 1) {
    // 「消えた計画」と「別端末の更新」を区別する。前者を409にすると、
    // 画面が読み込み直しを繰り返しても直らない案内を出してしまう。
    const rows = await all<{ version: number }>(
      "SELECT version FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1", [id],
    );
    const currentVersion = Number(rows[0]?.version || 0);
    if (!rows.length) throw new BadRequest("計画が見つかりません");
    throw new VersionConflict("計画が別の端末で更新されています", currentVersion);
  }
  return expectedVersion !== undefined ? expectedVersion + 1 : 0;
}

export async function deletePlan(id: string): Promise<void> {
  await pool.query("UPDATE plans SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

/** 計画本文（行程・都市・リンク・チェックリスト・候補）を一括置換する。 */
export async function replacePlanContent(planId: string, body: {
  itinerary?: Record<string, unknown>[];
  cities?: { name: string }[];
  links?: Record<string, unknown>[];
  checklist?: { label: string; status?: string }[];
  candidates?: { id?: string; title: string; place?: string | null; proposed_by_id?: string | null; adopted?: boolean; votes?: string[] }[];
}, expectedVersion?: number): Promise<number> {
  return withTransaction(async (conn) => {
    const planRow = await firstRow<{ version: number }>(
      conn,
      "SELECT version FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE",
      [planId],
    );
    const currentVersion = Number(planRow?.version || 0);
    if (!currentVersion) throw new BadRequest("計画が見つかりません");
    if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
      throw new VersionConflict("計画が別の端末で更新されています", currentVersion);
    }

    if (body.cities) {
      const statusRow = await firstRow<{ status: string }>(conn, "SELECT status FROM plans WHERE id = ? LIMIT 1", [planId]);
      const status = String(statusRow?.status || "draft");
      if (status === "published" && !body.cities.some((city) => String(city?.name || "").trim())) {
        throw new BadRequest("公開中の計画には訪問地が1つ以上必要です。先に下書きへ戻してください");
      }
    }

    if (body.itinerary) {
      await conn.query("DELETE FROM itinerary_items WHERE plan_id = ?", [planId]);
      // 日付・時刻・座標・分数は、DBの厳格モードで500になる前に安全な値へ丸める。
      const dateOrNull = (v: unknown): string | null =>
        /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;
      const timeOrNull = (v: unknown): string | null =>
        /^\d{1,2}:\d{2}(:\d{2})?$/.test(String(v || "")) ? String(v) : null;
      const numOrNull = (v: unknown, min: number, max: number): number | null => {
        if (v === null || v === undefined || v === "") return null;
        const n = Number(v);
        return Number.isFinite(n) && n >= min && n <= max ? n : null;
      };
      // 対象メンバー。user_id の配列だけ受け付け、それ以外や空は NULL（＝全員）に落とす。
      const memberIdsOrNull = (v: unknown): string | null => {
        if (!Array.isArray(v)) return null;
        const ids = [...new Set(v.filter((x) => typeof x === "string" && x && x.length <= 64))].slice(0, 50);
        return ids.length ? JSON.stringify(ids) : null;
      };
      const rows = body.itinerary.map((it, i) => [
        newId("itm"), planId, dateOrNull(it.item_date), numOrNull(it.day_index, 0, 1000), i,
        it.kind || "sight", timeOrNull(it.start_time), String(it.title || "").slice(0, 200),
        it.place || null, it.area || null, it.note || null, it.map_query || null,
        numOrNull(it.lat, -90, 90), numOrNull(it.lng, -180, 180),
        it.from_place || null, numOrNull(it.from_lat, -90, 90), numOrNull(it.from_lng, -180, 180),
        it.to_place || null, numOrNull(it.to_lat, -90, 90), numOrNull(it.to_lng, -180, 180),
        it.transport || null, numOrNull(it.duration_minutes, 0, 100_000),
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
      const rows = body.cities.filter((c) => c && c.name).map((c, i) => [newId("cty"), planId, String(c.name).slice(0, 100), i]);
      if (rows.length) await conn.query("INSERT INTO plan_cities (id, plan_id, name, sort_order) VALUES ?", [rows]);
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
      await conn.query("DELETE FROM plan_candidates WHERE plan_id = ?", [planId]); // votes は CASCADE
      const candRows: unknown[][] = [];
      const voteRows: unknown[][] = [];
      for (const c of body.candidates) {
        if (!c || !c.title) continue;
        const cid = c.id && /^[\w-]{1,32}$/.test(c.id) ? c.id : newId("cnd");
        candRows.push([cid, planId, String(c.title).slice(0, 200), c.place || null, c.proposed_by_id || null, c.adopted ? new Date() : null]);
        for (const uid of new Set(c.votes || [])) voteRows.push([cid, uid]);
      }
      if (candRows.length) {
        await conn.query("INSERT INTO plan_candidates (id, plan_id, title, place, proposed_by_id, adopted_at) VALUES ?", [candRows]);
      }
      if (voteRows.length) {
        await conn.query("INSERT IGNORE INTO plan_candidate_votes (candidate_id, user_id) VALUES ?", [voteRows]);
      }
    }

    await conn.query("UPDATE plans SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
    return currentVersion + 1;
  });
}

export async function countView(planId: string): Promise<void> {
  await pool.query(
    `INSERT INTO plan_view_daily (plan_id, viewed_on, view_count) VALUES (?, CURRENT_DATE, 1)
     ON DUPLICATE KEY UPDATE view_count = view_count + 1`,
    [planId],
  );
}
