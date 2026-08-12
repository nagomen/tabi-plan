// 関係テーブルへのアクセス。SQL はこのファイルに閉じる。
//
// 方針:
//   - 読みは bootstrap で1往復（フロントが同期読み取りできるよう全部渡す）。
//   - 書きは「同時更新が起きる費用」だけ行単位。行程やチェックリストなど
//     エディタが文書ごと保存する種類は一括置換にする（差分計算層を持たない）。

import mysql from "mysql2/promise";
import { config } from "./config.js";
import type { Bootstrap } from "./types.js";

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: 8,
  charset: "utf8mb4",
  dateStrings: true, // DATE / TIMESTAMP を文字列で受け取り、TZ 変換で日付がずれるのを避ける
  supportBigNumbers: true,
});

type Row = mysql.RowDataPacket;

let idSeq = 0;
export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36).padStart(3, "0")}`;
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<Row[]>(sql, params);
  return rows as unknown as T[];
}

export async function ping(): Promise<void> {
  await pool.query("SELECT 1");
}

// ---- 読み取り -----------------------------------------------------------

export async function bootstrap(): Promise<Bootstrap> {
  const [
    users, credentials, plans, members, itinerary, cities, links, checklist,
    candidates, candidateVotes, expenses, expenseShares, settlements, views,
    paymentLinks, userSettings, friendships,
  ] = await Promise.all([
    all("SELECT id, display_name FROM users ORDER BY created_at"),
    all("SELECT user_id, email FROM user_credentials"),
    all(`SELECT id, slug, title, note, start_date, end_date, dates_label, cover_url,
           base_currency, source, visibility, status, open_editing, owner_user_id,
           external_spreadsheet_id, external_apps_script_url, external_schema,
           created_at, updated_at
         FROM plans WHERE deleted_at IS NULL ORDER BY created_at`),
    all("SELECT plan_id, user_id, role, status FROM plan_members WHERE status = 'active'"),
    all(`SELECT id, plan_id, item_date, day_index, sort_order, kind, start_time, title, place,
           area, note, map_query, lat, lng, from_place, to_place, transport, duration_minutes
         FROM itinerary_items ORDER BY plan_id, item_date, sort_order`),
    all("SELECT id, plan_id, name, sort_order FROM plan_cities ORDER BY plan_id, sort_order"),
    all("SELECT id, plan_id, link_key, label, url, caption, sort_order FROM plan_links ORDER BY plan_id, sort_order"),
    all("SELECT id, plan_id, label, status, sort_order FROM plan_checklist_items ORDER BY plan_id, sort_order"),
    all("SELECT id, plan_id, title, place, proposed_by_id, adopted_at FROM plan_candidates ORDER BY plan_id, created_at"),
    all("SELECT candidate_id, user_id FROM plan_candidate_votes"),
    all(`SELECT id, plan_id, paid_on, payer_user_id, category, title, amount_minor, currency,
           fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url,
           created_at, deleted_at
         FROM expenses WHERE deleted_at IS NULL ORDER BY plan_id, created_at`),
    all(`SELECT s.expense_id, s.user_id, s.amount_base_minor FROM expense_shares s
           JOIN expenses e ON e.id = s.expense_id WHERE e.deleted_at IS NULL`),
    all(`SELECT id, plan_id, from_user_id, to_user_id, amount_base_minor, note, settled_at, deleted_at
         FROM settlements WHERE deleted_at IS NULL ORDER BY plan_id, settled_at`),
    all("SELECT plan_id, CAST(SUM(view_count) AS SIGNED) AS view_count FROM plan_view_daily GROUP BY plan_id"),
    all("SELECT user_id, provider, handle FROM user_payment_links"),
    all("SELECT user_id, history_public FROM user_settings"),
    all(`SELECT id, user_low_id, user_high_id, requested_by_id, status, created_at, responded_at
         FROM friendships`),
  ]);
  return {
    users, credentials, plans, members, itinerary, cities, links, checklist,
    candidates, candidateVotes, expenses, expenseShares, settlements, views,
    paymentLinks, userSettings, friendships,
  } as Bootstrap;
}

// ---- ユーザー -----------------------------------------------------------

const nameKey = (s: string): string => String(s || "").trim().toLowerCase();

export async function createUser(displayName: string, id?: string): Promise<{ id: string; display_name: string }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  const userId = id || newId("usr");
  await pool.query("INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)", [userId, name, nameKey(name)]);
  return { id: userId, display_name: name };
}

/** 表示名から既存ユーザーを引き、無ければ作る（招待前でも実体を持たせる方針）。 */
export async function ensureUserByName(displayName: string): Promise<{ id: string; display_name: string }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  const found = await all<{ id: string; display_name: string }>(
    "SELECT id, display_name FROM users WHERE name_key = ? ORDER BY created_at LIMIT 1",
    [nameKey(name)],
  );
  if (found[0]) return found[0];
  return createUser(name);
}

export async function renameUser(userId: string, displayName: string): Promise<void> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  await pool.query("UPDATE users SET display_name = ?, name_key = ? WHERE id = ?", [name, nameKey(name), userId]);
}

export async function upsertCredentials(input: {
  user_id: string; email: string; salt: string; hash: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO user_credentials (user_id, email, password_salt, password_hash)
     VALUES (?, ?, FROM_BASE64(?), FROM_BASE64(?))
     ON DUPLICATE KEY UPDATE email = VALUES(email),
       password_salt = VALUES(password_salt), password_hash = VALUES(password_hash)`,
    [input.user_id, String(input.email).toLowerCase(), input.salt, input.hash],
  );
}

/** ログイン照合用。ハッシュは base64 で返す（比較はフロントで定数時間比較する）。 */
export async function credentialByEmail(email: string): Promise<
  { user_id: string; display_name: string; email: string; salt: string; hash: string; iterations: number } | null
> {
  const rows = await all<{ user_id: string; display_name: string; email: string; salt: string; hash: string; iterations: number }>(
    `SELECT c.user_id, u.display_name, c.email, TO_BASE64(c.password_salt) AS salt,
            TO_BASE64(c.password_hash) AS hash, c.iterations
       FROM user_credentials c JOIN users u ON u.id = c.user_id
      WHERE c.email = ? LIMIT 1`,
    [String(email || "").toLowerCase()],
  );
  return rows[0] || null;
}

export async function setPaymentLink(userId: string, handle: string): Promise<void> {
  if (!handle) {
    await pool.query("DELETE FROM user_payment_links WHERE user_id = ? AND provider = 'paypay'", [userId]);
    return;
  }
  await pool.query(
    `INSERT INTO user_payment_links (user_id, provider, handle) VALUES (?, 'paypay', ?)
     ON DUPLICATE KEY UPDATE handle = VALUES(handle)`,
    [userId, handle.slice(0, 255)],
  );
}

export async function setUserSettings(userId: string, historyPublic: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO user_settings (user_id, history_public) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE history_public = VALUES(history_public)`,
    [userId, historyPublic ? 1 : 0],
  );
}

// ---- 計画 ---------------------------------------------------------------

const PLAN_FIELDS = new Set([
  "slug", "title", "note", "start_date", "end_date", "dates_label", "cover_url",
  "base_currency", "source", "visibility", "status", "open_editing", "owner_user_id",
  "external_spreadsheet_id", "external_apps_script_url", "external_schema",
]);

export async function createPlan(input: Record<string, unknown>): Promise<{ id: string }> {
  const id = String(input.id || newId("pln"));
  const cols: string[] = ["id"];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(input)) {
    if (!PLAN_FIELDS.has(k)) continue;
    cols.push(k);
    vals.push(v === "" ? null : v);
  }
  if (!cols.includes("slug") || !cols.includes("title")) throw new BadRequest("slug と title が必要です");
  await pool.query(`INSERT INTO plans (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
  return { id };
}

export async function updatePlan(id: string, input: Record<string, unknown>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (!PLAN_FIELDS.has(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(v === "" ? null : v);
  }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`, vals);
}

export async function deletePlan(id: string): Promise<void> {
  await pool.query("UPDATE plans SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

export async function replaceMembers(
  planId: string,
  members: { user_id: string; role?: string }[],
): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM plan_members WHERE plan_id = ?", [planId]);
    const rows = members
      .filter((m) => m && m.user_id)
      .map((m) => [planId, m.user_id, m.role === "owner" || m.role === "viewer" ? m.role : "editor", "active"]);
    if (rows.length) {
      await conn.query("INSERT INTO plan_members (plan_id, user_id, role, status) VALUES ?", [rows]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/** 計画本文（行程・都市・リンク・チェックリスト・候補）を一括置換する。 */
export async function replacePlanContent(planId: string, body: {
  itinerary?: Record<string, unknown>[];
  cities?: { name: string }[];
  links?: Record<string, unknown>[];
  checklist?: { label: string; status?: string }[];
  candidates?: { id?: string; title: string; place?: string | null; proposed_by_id?: string | null; adopted?: boolean; votes?: string[] }[];
}): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (body.itinerary) {
      await conn.query("DELETE FROM itinerary_items WHERE plan_id = ?", [planId]);
      const rows = body.itinerary.map((it, i) => [
        newId("itm"), planId, it.item_date || null, it.day_index ?? null, i,
        it.kind || "sight", it.start_time || null, String(it.title || "").slice(0, 200),
        it.place || null, it.area || null, it.note || null, it.map_query || null,
        it.lat ?? null, it.lng ?? null,
        it.from_place || null, it.to_place || null, it.transport || null, it.duration_minutes ?? null,
      ]);
      if (rows.length) {
        await conn.query(
          `INSERT INTO itinerary_items (id, plan_id, item_date, day_index, sort_order, kind, start_time,
             title, place, area, note, map_query, lat, lng, from_place, to_place, transport, duration_minutes)
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
        if (!l.url || seen.has(key)) return;
        seen.add(key);
        rows.push([newId("lnk"), planId, key, String(l.label || key).slice(0, 80), String(l.url).slice(0, 1024), l.caption || null, i]);
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

    await conn.query("UPDATE plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", [planId]);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function countView(planId: string): Promise<void> {
  await pool.query(
    `INSERT INTO plan_view_daily (plan_id, viewed_on, view_count) VALUES (?, CURRENT_DATE, 1)
     ON DUPLICATE KEY UPDATE view_count = view_count + 1`,
    [planId],
  );
}

// ---- 費用 ---------------------------------------------------------------

export interface ExpenseInput {
  id?: string;
  paid_on?: string | null;
  payer_user_id: string;
  category?: string;
  title?: string;
  amount_minor: number;
  currency?: string;
  fx_rate?: number;
  split_method?: string;
  payment_method?: string | null;
  note?: string | null;
  receipt_url?: string | null;
  created_by_id?: string | null;
  shares: { user_id: string; amount_base_minor: number }[];
}

const CATEGORIES = new Set(["food", "transport", "lodging", "sightseeing", "communication", "other"]);
const SPLIT = new Set(["equal_all", "equal_selected", "custom", "none"]);
const PAY = new Set(["card", "cash", "transfer", "other"]);

/** 費用を1件追加する。行の INSERT なので、複数端末の同時追加でも衝突しない。 */
export async function createExpense(planId: string, input: ExpenseInput): Promise<{ id: string }> {
  const id = input.id && /^[\w-]{1,32}$/.test(input.id) ? input.id : newId("exp");
  const amount = Math.round(Number(input.amount_minor) || 0);
  const rate = Number(input.fx_rate) > 0 ? Number(input.fx_rate) : 1;
  const base = Math.round(amount * rate);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO expenses (id, plan_id, paid_on, payer_user_id, category, title, amount_minor,
         currency, fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url, created_by_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, planId, input.paid_on || null, input.payer_user_id,
        CATEGORIES.has(String(input.category)) ? input.category : "other",
        String(input.title || "").slice(0, 200), amount,
        String(input.currency || "JPY").toUpperCase().slice(0, 3), rate, base,
        SPLIT.has(String(input.split_method)) ? input.split_method : "equal_all",
        PAY.has(String(input.payment_method)) ? input.payment_method : null,
        input.note || null, input.receipt_url || null, input.created_by_id || null,
      ],
    );
    await insertShares(conn, id, input.shares);
    await conn.commit();
    return { id };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function insertShares(
  conn: mysql.PoolConnection,
  expenseId: string,
  shares: { user_id: string; amount_base_minor: number }[],
): Promise<void> {
  const rows = (shares || [])
    .filter((s) => s && s.user_id && Number(s.amount_base_minor) > 0)
    .map((s) => [expenseId, s.user_id, Math.round(Number(s.amount_base_minor))]);
  if (rows.length) {
    await conn.query("INSERT INTO expense_shares (expense_id, user_id, amount_base_minor) VALUES ?", [rows]);
  }
}

export async function updateExpense(id: string, input: ExpenseInput): Promise<void> {
  const amount = Math.round(Number(input.amount_minor) || 0);
  const rate = Number(input.fx_rate) > 0 ? Number(input.fx_rate) : 1;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE expenses SET paid_on = ?, payer_user_id = ?, category = ?, title = ?, amount_minor = ?,
         currency = ?, fx_rate = ?, amount_base_minor = ?, split_method = ?, payment_method = ?,
         note = ?, receipt_url = ? WHERE id = ?`,
      [
        input.paid_on || null, input.payer_user_id,
        CATEGORIES.has(String(input.category)) ? input.category : "other",
        String(input.title || "").slice(0, 200), amount,
        String(input.currency || "JPY").toUpperCase().slice(0, 3), rate, Math.round(amount * rate),
        SPLIT.has(String(input.split_method)) ? input.split_method : "equal_all",
        PAY.has(String(input.payment_method)) ? input.payment_method : null,
        input.note || null, input.receipt_url || null, id,
      ],
    );
    await conn.query("DELETE FROM expense_shares WHERE expense_id = ?", [id]);
    await insertShares(conn, id, input.shares);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

/** 論理削除（UI に「元に戻す」があるため物理削除しない）。 */
export async function deleteExpense(id: string): Promise<void> {
  await pool.query("UPDATE expenses SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

export async function restoreExpense(id: string): Promise<void> {
  await pool.query("UPDATE expenses SET deleted_at = NULL WHERE id = ?", [id]);
}

export async function createSettlement(planId: string, input: {
  from_user_id: string; to_user_id: string; amount_base_minor: number; note?: string | null; created_by_id?: string | null;
}): Promise<{ id: string }> {
  const id = newId("stl");
  await pool.query(
    `INSERT INTO settlements (id, plan_id, from_user_id, to_user_id, amount_base_minor, note, created_by_id)
     VALUES (?,?,?,?,?,?,?)`,
    [id, planId, input.from_user_id, input.to_user_id, Math.round(Number(input.amount_base_minor) || 0),
     input.note || null, input.created_by_id || null],
  );
  return { id };
}

// ---- 友達 ---------------------------------------------------------------

export async function upsertFriendship(input: {
  a: string; b: string; requested_by_id: string; status?: string;
}): Promise<{ id: string }> {
  const [low, high] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  const existing = await all<{ id: string }>(
    "SELECT id FROM friendships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1", [low, high],
  );
  if (existing[0]) {
    await pool.query(
      "UPDATE friendships SET status = ?, responded_at = CURRENT_TIMESTAMP WHERE id = ?",
      [input.status || "pending", existing[0].id],
    );
    return existing[0];
  }
  const id = newId("frd");
  await pool.query(
    "INSERT INTO friendships (id, user_low_id, user_high_id, requested_by_id, status) VALUES (?,?,?,?,?)",
    [id, low, high, input.requested_by_id, input.status || "pending"],
  );
  return { id };
}

export class BadRequest extends Error {}
