// 関係テーブルへのアクセス。SQL はこのファイルに閉じる。
//
// 方針:
//   - 読みは bootstrap で1往復（フロントが同期読み取りできるよう全部渡す）。
//   - 書きは「同時更新が起きる費用」だけ行単位。行程やチェックリストなど
//     エディタが文書ごと保存する種類は一括置換にする（差分計算層を持たない）。

import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { Bootstrap, ExpenseRow, ExpenseShareRow, PlanMemberRow, PlanRow, SettlementRow } from "./types.js";

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
const pbkdf2 = promisify(crypto.pbkdf2);
const PASSWORD_ITERATIONS = 100_000;

let idSeq = 0;
export function newId(prefix: string): string {
  idSeq = (idSeq + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36).padStart(3, "0")}`;
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await pool.query<Row[]>(sql, params);
  return rows as unknown as T[];
}

function inClause(ids: string[]): { sql: string; params: string[] } {
  return { sql: ids.map(() => "?").join(","), params: ids };
}

export async function ping(): Promise<void> {
  await pool.query("SELECT 1");
}

// ---- 読み取り -----------------------------------------------------------

export async function bootstrap(): Promise<Bootstrap> {
  return bootstrapForUser("");
}

export async function bootstrapForUser(userId = ""): Promise<Bootstrap> {
  return restrictedBootstrapForUser(userId);
}

async function restrictedBootstrapForUser(userId = ""): Promise<Bootstrap> {
  const actorJoin = userId
    ? "LEFT JOIN plan_members pm ON pm.plan_id = p.id AND pm.user_id = ? AND pm.status = 'active'"
    : "";
  const actorParams = userId ? [userId] : [];
  const publicPredicate = "(p.visibility = 'public' AND p.status = 'published')";
  // open_editing は公開済み計画の本文をログイン利用者が編集するための権限。
  // メンバー・費用・精算を含むワークスペース情報は正式な参加者だけに返す。
  const memberPredicate = userId ? "pm.user_id IS NOT NULL" : "FALSE";
  const collaborativePredicate = userId
    ? "(p.open_editing = 1 AND p.visibility = 'public' AND p.status = 'published')"
    : "FALSE";
  const visibleWhere = `p.deleted_at IS NULL AND (${publicPredicate} OR ${memberPredicate} OR ${collaborativePredicate})`;
  const workspaceWhere = `p.deleted_at IS NULL AND ${memberPredicate}`;

  const [plans, workspaceRows, credentials, userSettings, friendships] = await Promise.all([
    all<PlanRow>(`SELECT p.id, p.slug, p.title, p.note, p.start_date, p.end_date, p.dates_label, p.cover_url,
           p.base_currency, p.source, p.visibility, p.status, p.open_editing, p.owner_user_id,
           p.external_spreadsheet_id, p.external_apps_script_url, p.external_schema,
           p.created_at, p.updated_at
         FROM plans p ${actorJoin}
         WHERE ${visibleWhere}
         ORDER BY p.created_at`, actorParams),
    all<{ id: string }>(`SELECT p.id FROM plans p ${actorJoin} WHERE ${workspaceWhere}`, actorParams),
    userId ? all("SELECT user_id, email FROM user_credentials WHERE user_id = ?", [userId]) : [],
    userId ? all("SELECT user_id, history_public FROM user_settings WHERE user_id = ?", [userId]) : [],
    userId
      ? all(`SELECT id, user_low_id, user_high_id, requested_by_id, status, created_at, responded_at
         FROM friendships WHERE user_low_id = ? OR user_high_id = ?`, [userId, userId])
      : [],
  ]);

  const visiblePlanIds = plans.map((plan) => plan.id);
  const workspacePlanIdSet = new Set(workspaceRows.map((row) => row.id));
  const workspacePlanIds = visiblePlanIds.filter((id) => workspacePlanIdSet.has(id));
  const publicOnlyPlanIds = visiblePlanIds.filter((id) => !workspacePlanIdSet.has(id));

  const visibleIn = inClause(visiblePlanIds);
  const [itinerary, cities, views] = visiblePlanIds.length
    ? await Promise.all([
      all<Bootstrap["itinerary"][number]>(`SELECT id, plan_id, item_date, day_index, sort_order, kind, start_time, title, place,
           area, note, map_query, lat, lng, from_place, to_place, transport, duration_minutes
         FROM itinerary_items
         WHERE plan_id IN (${visibleIn.sql})
         ORDER BY plan_id, item_date, sort_order`, visibleIn.params),
      all<Bootstrap["cities"][number]>(`SELECT id, plan_id, name, sort_order FROM plan_cities
         WHERE plan_id IN (${visibleIn.sql})
         ORDER BY plan_id, sort_order`, visibleIn.params),
      all<Bootstrap["views"][number]>(`SELECT plan_id, CAST(SUM(view_count) AS SIGNED) AS view_count FROM plan_view_daily
         WHERE plan_id IN (${visibleIn.sql})
         GROUP BY plan_id`, visibleIn.params),
    ])
    : [[], [], []];

  const workspaceIn = inClause(workspacePlanIds);
  const [members, checklist, candidates, expenses, expenseShares, settlements] = workspacePlanIds.length
    ? await Promise.all([
      all<PlanMemberRow>(`SELECT plan_id, user_id, role, status FROM plan_members
         WHERE status = 'active' AND plan_id IN (${workspaceIn.sql})`, workspaceIn.params),
      all<Bootstrap["checklist"][number]>(`SELECT id, plan_id, label, status, sort_order FROM plan_checklist_items
         WHERE plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, sort_order`, workspaceIn.params),
      all<Bootstrap["candidates"][number]>(`SELECT id, plan_id, title, place, proposed_by_id, adopted_at FROM plan_candidates
         WHERE plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, created_at`, workspaceIn.params),
      all<ExpenseRow>(`SELECT id, plan_id, paid_on, payer_user_id, category, title, amount_minor, currency,
           fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url,
           created_at, deleted_at
         FROM expenses
         WHERE plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, created_at`, workspaceIn.params),
      all<ExpenseShareRow>(`SELECT s.expense_id, s.user_id, s.amount_base_minor FROM expense_shares s
         JOIN expenses e ON e.id = s.expense_id
         WHERE e.plan_id IN (${workspaceIn.sql})`, workspaceIn.params),
      all<SettlementRow>(`SELECT id, plan_id, from_user_id, to_user_id, amount_base_minor, note, settled_at, deleted_at
         FROM settlements
         WHERE deleted_at IS NULL AND plan_id IN (${workspaceIn.sql})
         ORDER BY plan_id, settled_at`, workspaceIn.params),
    ])
    : [[], [], [], [], [], []];

  const candidateIn = inClause(candidates.map((candidate) => String(candidate.id)));
  const candidateVotes = candidates.length
    ? await all(`SELECT candidate_id, user_id FROM plan_candidate_votes WHERE candidate_id IN (${candidateIn.sql})`, candidateIn.params)
    : [];

  const publicOnlyIn = inClause(publicOnlyPlanIds);
  const linkClauses: string[] = [];
  const linkParams: string[] = [];
  if (workspacePlanIds.length) {
    linkClauses.push(`plan_id IN (${workspaceIn.sql})`);
    linkParams.push(...workspaceIn.params);
  }
  if (publicOnlyPlanIds.length) {
    linkClauses.push(`(plan_id IN (${publicOnlyIn.sql}) AND link_key IN ('itinerary', 'maps', 'photos'))`);
    linkParams.push(...publicOnlyIn.params);
  }
  const links = linkClauses.length
    ? await all(`SELECT id, plan_id, link_key, label, url, caption, sort_order FROM plan_links
         WHERE ${linkClauses.join(" OR ")}
         ORDER BY plan_id, sort_order`, linkParams)
    : [];

  const workspaceUserIds = new Set<string>();
  for (const member of members as PlanMemberRow[]) workspaceUserIds.add(member.user_id);
  for (const expense of expenses as ExpenseRow[]) workspaceUserIds.add(expense.payer_user_id);
  for (const share of expenseShares as ExpenseShareRow[]) workspaceUserIds.add(share.user_id);
  for (const settlement of settlements as SettlementRow[]) {
    workspaceUserIds.add(settlement.from_user_id);
    workspaceUserIds.add(settlement.to_user_id);
  }
  if (userId) workspaceUserIds.add(userId);

  const visibleUserIds = new Set(workspaceUserIds);
  for (const plan of plans) {
    if (plan.owner_user_id) visibleUserIds.add(plan.owner_user_id);
  }

  const visibleUserIn = inClause([...visibleUserIds]);
  const users = visibleUserIds.size
    ? await all(`SELECT id, display_name FROM users WHERE id IN (${visibleUserIn.sql}) ORDER BY created_at`, visibleUserIn.params)
    : [];

  const paymentUserIn = inClause([...workspaceUserIds]);
  const paymentLinks = workspaceUserIds.size
    ? await all(`SELECT user_id, provider, handle FROM user_payment_links WHERE user_id IN (${paymentUserIn.sql})`, paymentUserIn.params)
    : [];

  return {
    users, credentials, plans, members, itinerary, cities, links, checklist,
    candidates, candidateVotes, expenses, expenseShares, settlements, views,
    paymentLinks, userSettings, friendships,
  } as Bootstrap;
}

export async function planRole(planId: string, userId: string): Promise<"owner" | "editor" | "viewer" | null> {
  if (!userId) return null;
  const rows = await all<{ role: "owner" | "editor" | "viewer" }>(
    "SELECT role FROM plan_members WHERE plan_id = ? AND user_id = ? AND status = 'active' LIMIT 1",
    [planId, userId],
  );
  return rows[0]?.role || null;
}

export async function canEditPlan(planId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const plans = await all<{ visibility: "public" | "invite"; status: "draft" | "published"; open_editing: 0 | 1 }>(
    "SELECT visibility, status, open_editing FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [planId],
  );
  if (!plans[0]) return false;
  const role = await planRole(planId, userId);
  if (role === "owner" || role === "editor") return true;
  return Boolean(plans[0].open_editing && plans[0].visibility === "public" && plans[0].status === "published");
}

export async function canManagePlan(planId: string, userId: string): Promise<boolean> {
  if (!userId) return false;
  const role = await planRole(planId, userId);
  return role === "owner";
}

/** 正式メンバーとして、費用・精算を含むワークスペースを更新できるか。 */
export async function canEditPlanWorkspace(planId: string, userId: string): Promise<boolean> {
  const role = await planRole(planId, userId);
  return role === "owner" || role === "editor";
}

export async function canInvitePlan(planId: string, userId: string): Promise<boolean> {
  return canManagePlan(planId, userId);
}

export async function canViewPlan(planId: string, userId: string): Promise<boolean> {
  const plans = await all<{ visibility: "public" | "invite"; status: "draft" | "published"; open_editing: 0 | 1 }>(
    "SELECT visibility, status, open_editing FROM plans WHERE id = ? AND deleted_at IS NULL LIMIT 1",
    [planId],
  );
  const plan = plans[0];
  if (!plan) return false;
  if (userId && await planRole(planId, userId)) return true;
  return plan.visibility === "public" && plan.status === "published";
}

export async function planIdForExpense(expenseId: string): Promise<string | null> {
  const rows = await all<{ plan_id: string }>("SELECT plan_id FROM expenses WHERE id = ? LIMIT 1", [expenseId]);
  return rows[0]?.plan_id || null;
}

function tokenHash(token: string): Buffer {
  return crypto.createHash("sha256").update(token, "utf8").digest();
}

function safeUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString().slice(0, 1024);
  } catch {
    /* relative URLs are allowed for local static assets */
  }
  if (/^(?:\.{0,2}\/|\/)[^\s<>"']{1,1024}$/.test(raw) && !raw.startsWith("//")) return raw.slice(0, 1024);
  return "";
}

async function activeMemberIds(planId: string, conn: mysql.PoolConnection | mysql.Pool = pool): Promise<string[]> {
  const [rows] = await conn.query<Row[]>(
    "SELECT user_id FROM plan_members WHERE plan_id = ? AND status = 'active'",
    [planId],
  );
  return (rows as unknown as { user_id: string }[]).map((row) => row.user_id);
}

async function activeMemberSet(planId: string, conn: mysql.PoolConnection | mysql.Pool = pool): Promise<Set<string>> {
  return new Set(await activeMemberIds(planId, conn));
}

function assertMember(memberIds: Set<string>, userId: string, label: string): void {
  if (!userId || !memberIds.has(userId)) throw new BadRequest(`${label} は有効な計画参加者である必要があります`);
}

function friendshipPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

async function ensureAcceptedFriendship(
  a: string,
  b: string,
  requestedById: string,
  conn: mysql.PoolConnection | mysql.Pool = pool,
): Promise<void> {
  if (!a || !b || a === b) return;
  const [low, high] = friendshipPair(a, b);
  await conn.query(
    `INSERT INTO friendships (id, user_low_id, user_high_id, requested_by_id, status, responded_at)
     VALUES (?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)
     ON DUPLICATE KEY UPDATE
       status = 'accepted',
       responded_at = CURRENT_TIMESTAMP`,
    [newId("frd"), low, high, requestedById],
  );
}

async function ensurePlanMembersAreFriends(
  planId: string,
  requestedById: string,
  conn: mysql.PoolConnection | mysql.Pool = pool,
): Promise<void> {
  const ids = Array.from(new Set(await activeMemberIds(planId, conn)));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      await ensureAcceptedFriendship(ids[i], ids[j], requestedById, conn);
    }
  }
}

export async function createInvite(input: {
  planId: string;
  createdById: string;
  invitedName?: string;
  role?: "editor" | "viewer";
}): Promise<{ token: string }> {
  const token = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO plan_invites (id, plan_id, token_hash, role, status, invited_name, created_by_id, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 30 DAY))`,
    [
      newId("inv"),
      input.planId,
      tokenHash(token),
      input.role === "viewer" ? "viewer" : "editor",
      String(input.invitedName || "").trim().slice(0, 64) || null,
      input.createdById,
    ],
  );
  return { token };
}

export async function acceptInvite(token: string, userId: string): Promise<{ planSlug: string }> {
  if (!userId) throw new BadRequest("ログインが必要です");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<Row[]>(
      `SELECT i.id, i.plan_id, i.role, i.status, i.created_by_id, i.accepted_by_id, i.expires_at, p.slug
         FROM plan_invites i
         JOIN plans p ON p.id = i.plan_id AND p.deleted_at IS NULL
        WHERE i.token_hash = ?
        LIMIT 1
        FOR UPDATE`,
      [tokenHash(token)],
    );
    const invite = (rows as unknown as {
      id: string;
      plan_id: string;
      role: "editor" | "viewer";
      status: "pending" | "accepted" | "revoked" | "expired";
      created_by_id: string;
      accepted_by_id: string | null;
      expires_at: string | null;
      slug: string;
    }[])[0];
    if (!invite) throw new BadRequest("招待リンクが無効です");
    if (invite.status === "revoked" || invite.status === "expired") throw new BadRequest("この招待リンクは使えません");
    if (invite.status === "accepted" && invite.accepted_by_id !== userId) throw new BadRequest("この招待リンクは既に使われています");
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      await conn.query("UPDATE plan_invites SET status = 'expired' WHERE id = ?", [invite.id]);
      throw new BadRequest("この招待リンクは期限切れです");
    }
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status, invited_by_id)
       VALUES (?, ?, ?, 'active', ?)
       ON DUPLICATE KEY UPDATE
         role = IF(role = 'owner', role, VALUES(role)),
         status = 'active',
         invited_by_id = VALUES(invited_by_id)`,
      [invite.plan_id, userId, invite.role, invite.created_by_id],
    );
    const [updated] = await conn.query<mysql.ResultSetHeader>(
      `UPDATE plan_invites
          SET status = 'accepted', accepted_by_id = ?, accepted_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'`,
      [userId, invite.id],
    );
    if (updated.affectedRows !== 1 && invite.accepted_by_id !== userId) {
      throw new BadRequest("この招待リンクは既に使われています");
    }
    await ensurePlanMembersAreFriends(invite.plan_id, userId, conn);
    await conn.commit();
    return { planSlug: invite.slug };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

// ---- ユーザー -----------------------------------------------------------

const nameKey = (s: string): string => String(s || "").trim().toLowerCase();
const emailKey = (s: string): string => String(s || "").trim().toLowerCase();

async function passwordHash(password: string, salt: Buffer, iterations = PASSWORD_ITERATIONS): Promise<Buffer> {
  return pbkdf2(String(password || ""), salt, iterations, 32, "sha256");
}

function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function createUser(displayName: string, id?: string): Promise<{ id: string; display_name: string }> {
  const name = String(displayName || "").trim().slice(0, 64);
  if (!name) throw new BadRequest("display_name が必要です");
  const userId = id || newId("usr");
  await pool.query("INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)", [userId, name, nameKey(name)]);
  return { id: userId, display_name: name };
}

export async function signUp(input: {
  email: string;
  password: string;
  displayName: string;
}): Promise<{ user: { id: string; display_name: string; email: string } }> {
  const email = emailKey(input.email);
  const displayName = String(input.displayName || "").trim().slice(0, 64) || email.split("@")[0] || "ユーザー";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequest("メールアドレスの形式が正しくありません");
  if (String(input.password || "").length < 8) throw new BadRequest("パスワードは8文字以上にしてください");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query<Row[]>("SELECT user_id FROM user_credentials WHERE email = ? LIMIT 1", [email]);
    if ((existing as unknown[]).length) throw new BadRequest("このメールアドレスは既に登録されています");
    const userId = newId("usr");
    const salt = crypto.randomBytes(16);
    const hash = await passwordHash(input.password, salt);
    await conn.query("INSERT INTO users (id, display_name, name_key) VALUES (?, ?, ?)", [userId, displayName, nameKey(displayName)]);
    await conn.query(
      `INSERT INTO user_credentials (user_id, email, password_salt, password_hash, iterations)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, email, salt, hash, PASSWORD_ITERATIONS],
    );
    await conn.commit();
    return { user: { id: userId, display_name: displayName, email } };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function logIn(input: {
  email: string;
  password: string;
}): Promise<{ user: { id: string; display_name: string; email: string } }> {
  const email = emailKey(input.email);
  const rows = await all<{
    user_id: string; display_name: string; email: string; salt: Buffer; hash: Buffer; iterations: number;
  }>(
    `SELECT c.user_id, u.display_name, c.email, c.password_salt AS salt, c.password_hash AS hash, c.iterations
       FROM user_credentials c JOIN users u ON u.id = c.user_id
      WHERE c.email = ? LIMIT 1`,
    [email],
  );
  const found = rows[0];
  const salt = found?.salt || crypto.randomBytes(16);
  const expected = found?.hash || crypto.randomBytes(32);
  const candidate = await passwordHash(input.password, salt, found?.iterations || PASSWORD_ITERATIONS);
  if (!found || !timingSafeEqual(candidate, expected)) {
    throw new BadRequest("メールアドレスまたはパスワードが違います");
  }
  return { user: { id: found.user_id, display_name: found.display_name, email: found.email } };
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

export async function searchUsers(query: string, actorUserId: string): Promise<
  { id: string; display_name: string; email: string }[]
> {
  if (!actorUserId) throw new BadRequest("ログインが必要です");
  const q = String(query || "").trim().slice(0, 64);
  if (!q) return [];
  const key = nameKey(q);
  const email = emailKey(q);
  const rows = await all<{ id: string; display_name: string; email: string | null }>(
    `SELECT u.id, u.display_name, CASE WHEN c.email = ? THEN c.email ELSE '' END AS email
       FROM users u
       LEFT JOIN user_credentials c ON c.user_id = u.id
      WHERE u.id <> ?
        AND (u.name_key LIKE ? OR c.email = ?)
      ORDER BY u.created_at DESC
      LIMIT 20`,
    [email, actorUserId, `%${key}%`, email],
  );
  return rows.map((row) => ({ id: row.id, display_name: row.display_name, email: row.email || "" }));
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

const PLAN_EDIT_FIELDS = new Set([
  "title", "note", "start_date", "end_date", "dates_label", "cover_url", "base_currency",
]);
const PLAN_COLLABORATE_FIELDS = new Set([
  "title", "note", "start_date", "end_date", "dates_label", "cover_url",
]);
const PLAN_MANAGE_FIELDS = new Set([
  "slug", "source", "visibility", "status", "open_editing",
  "external_spreadsheet_id", "external_apps_script_url", "external_schema",
]);
const PLAN_CREATE_FIELDS = new Set([...PLAN_EDIT_FIELDS, ...PLAN_MANAGE_FIELDS, "owner_user_id"]);

export async function createPlan(input: Record<string, unknown>): Promise<{ id: string }> {
  const id = String(input.id || newId("pln"));
  const cols: string[] = ["id"];
  const vals: unknown[] = [id];
  for (const [k, v] of Object.entries(input)) {
    if (!PLAN_CREATE_FIELDS.has(k)) continue;
    cols.push(k);
    vals.push(v === "" ? null : v);
  }
  if (!cols.includes("slug") || !cols.includes("title")) throw new BadRequest("slug と title が必要です");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`INSERT INTO plans (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`, vals);
    const owner = String(input.owner_user_id || "");
    if (owner) {
      await conn.query(
        `INSERT INTO plan_members (plan_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')
         ON DUPLICATE KEY UPDATE role = 'owner', status = 'active'`,
        [id, owner],
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { id };
}

export async function updatePlan(
  id: string,
  input: Record<string, unknown>,
  scope: "collaborate" | "edit" | "manage" = "edit",
): Promise<void> {
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
  actorUserId = "",
): Promise<void> {
  const byUserId = new Map<string, { user_id: string; role: "owner" | "editor" | "viewer" }>();
  for (const member of members) {
    const userId = String(member?.user_id || "").trim();
    if (!userId) continue;
    const role = member.role === "owner" || member.role === "viewer" ? member.role : "editor";
    byUserId.set(userId, { user_id: userId, role });
  }
  const normalized = [...byUserId.values()];
  const owners = normalized.filter((member) => member.role === "owner");
  const owner = owners[0];
  if (owners.length !== 1) throw new BadRequest("計画には owner が1人だけ必要です");
  if (actorUserId && !normalized.some((member) => member.user_id === actorUserId && member.role === "owner")) {
    throw new BadRequest("自分の owner 権限は残してください。所有権の移譲には専用操作が必要です");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const activeIds = normalized.map((member) => member.user_id);
    const activeIn = inClause(activeIds);
    await conn.query(
      `UPDATE plan_members SET status = 'revoked'
       WHERE plan_id = ? AND user_id NOT IN (${activeIn.sql})`,
      [planId, ...activeIn.params],
    );
    const rows = normalized.map((member) => [planId, member.user_id, member.role, "active"]);
    await conn.query(
      `INSERT INTO plan_members (plan_id, user_id, role, status) VALUES ?
       ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active'`,
      [rows],
    );
    const ownerIds = normalized.filter((member) => member.role === "owner").map((member) => member.user_id);
    const ownerIn = inClause(ownerIds);
    const preferredOwner = normalized.some((member) => member.user_id === actorUserId && member.role === "owner")
      ? actorUserId
      : owner.user_id;
    await conn.query(
      `UPDATE plans
       SET owner_user_id = CASE
         WHEN owner_user_id IS NULL OR owner_user_id NOT IN (${ownerIn.sql}) THEN ?
         ELSE owner_user_id
       END
       WHERE id = ?`,
      [...ownerIn.params, preferredOwner, planId],
    );
    await ensurePlanMembersAreFriends(planId, actorUserId || owner.user_id, conn);
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function leavePlan(planId: string, userId: string): Promise<void> {
  const role = await planRole(planId, userId);
  if (!role) throw new BadRequest("この計画の参加者ではありません");
  if (role === "owner") {
    throw new BadRequest("所有者は脱退できません。先に所有権を移譲してください");
  }
  await pool.query(
    "UPDATE plan_members SET status = 'left' WHERE plan_id = ? AND user_id = ? AND status = 'active'",
    [planId, userId],
  );
}

export async function transferPlanOwnership(planId: string, actorUserId: string, targetUserId: string): Promise<void> {
  if (!targetUserId || targetUserId === actorUserId) throw new BadRequest("移譲先の参加者を指定してください");
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query<Row[]>(
      `SELECT user_id, role FROM plan_members
       WHERE plan_id = ? AND user_id IN (?, ?) AND status = 'active'
       FOR UPDATE`,
      [planId, actorUserId, targetUserId],
    );
    const members = rows as unknown as { user_id: string; role: "owner" | "editor" | "viewer" }[];
    if (!members.some((member) => member.user_id === actorUserId && member.role === "owner")) {
      throw new BadRequest("所有権を移譲できるのは現在の owner だけです");
    }
    if (!members.some((member) => member.user_id === targetUserId)) {
      throw new BadRequest("移譲先は有効な計画参加者である必要があります");
    }
    await conn.query(
      `UPDATE plan_members
       SET role = CASE WHEN user_id = ? THEN 'owner' ELSE 'editor' END
       WHERE plan_id = ? AND (role = 'owner' OR user_id = ?)`,
      [targetUserId, planId, targetUserId],
    );
    await conn.query("UPDATE plans SET owner_user_id = ? WHERE id = ?", [targetUserId, planId]);
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

function normalizeShares(shares: ExpenseInput["shares"]): { user_id: string; amount_base_minor: number }[] {
  const byUser = new Map<string, number>();
  for (const share of shares || []) {
    const userId = String(share?.user_id || "").trim();
    const amount = Math.round(Number(share?.amount_base_minor) || 0);
    if (!userId || amount <= 0) continue;
    byUser.set(userId, (byUser.get(userId) || 0) + amount);
  }
  return [...byUser.entries()].map(([user_id, amount_base_minor]) => ({ user_id, amount_base_minor }));
}

async function validateExpenseInput(
  planId: string,
  input: ExpenseInput,
  base: number,
  conn: mysql.PoolConnection,
): Promise<{ splitMethod: string; shares: { user_id: string; amount_base_minor: number }[] }> {
  const splitMethod = SPLIT.has(String(input.split_method)) ? String(input.split_method) : "equal_all";
  const memberIds = await activeMemberSet(planId, conn);
  assertMember(memberIds, String(input.payer_user_id || ""), "支払者");
  const shares = normalizeShares(input.shares);
  for (const share of shares) assertMember(memberIds, share.user_id, "負担者");
  const shareTotal = shares.reduce((sum, share) => sum + share.amount_base_minor, 0);
  if (splitMethod === "none") {
    if (shareTotal !== 0) throw new BadRequest("精算不要の費用には負担額を設定できません");
  } else if (shareTotal !== base) {
    throw new BadRequest("負担額の合計が支払額と一致していません");
  }
  return { splitMethod, shares };
}

/** 費用を1件追加する。行の INSERT なので、複数端末の同時追加でも衝突しない。 */
export async function createExpense(planId: string, input: ExpenseInput, actorUserId: string): Promise<{ id: string }> {
  const id = input.id && /^[\w-]{1,32}$/.test(input.id) ? input.id : newId("exp");
  const amount = Math.round(Number(input.amount_minor) || 0);
  const rate = Number(input.fx_rate) > 0 ? Number(input.fx_rate) : 1;
  const base = Math.round(amount * rate);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { splitMethod, shares } = await validateExpenseInput(planId, input, base, conn);
    await conn.query(
      `INSERT INTO expenses (id, plan_id, paid_on, payer_user_id, category, title, amount_minor,
         currency, fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url, created_by_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, planId, input.paid_on || null, input.payer_user_id,
        CATEGORIES.has(String(input.category)) ? input.category : "other",
        String(input.title || "").slice(0, 200), amount,
        String(input.currency || "JPY").toUpperCase().slice(0, 3), rate, base,
        splitMethod,
        PAY.has(String(input.payment_method)) ? input.payment_method : null,
        input.note || null, safeUrl(input.receipt_url), actorUserId || null,
      ],
    );
    await insertShares(conn, id, shares);
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
  const base = Math.round(amount * rate);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [expenseRows] = await conn.query<Row[]>("SELECT plan_id FROM expenses WHERE id = ? FOR UPDATE", [id]);
    const planId = (expenseRows as unknown as { plan_id: string }[])[0]?.plan_id;
    if (!planId) throw new BadRequest("費用が見つかりません");
    const { splitMethod, shares } = await validateExpenseInput(planId, input, base, conn);
    await conn.query(
      `UPDATE expenses SET paid_on = ?, payer_user_id = ?, category = ?, title = ?, amount_minor = ?,
         currency = ?, fx_rate = ?, amount_base_minor = ?, split_method = ?, payment_method = ?,
         note = ?, receipt_url = ? WHERE id = ?`,
      [
        input.paid_on || null, input.payer_user_id,
        CATEGORIES.has(String(input.category)) ? input.category : "other",
        String(input.title || "").slice(0, 200), amount,
        String(input.currency || "JPY").toUpperCase().slice(0, 3), rate, base,
        splitMethod,
        PAY.has(String(input.payment_method)) ? input.payment_method : null,
        input.note || null, safeUrl(input.receipt_url), id,
      ],
    );
    await conn.query("DELETE FROM expense_shares WHERE expense_id = ?", [id]);
    await insertShares(conn, id, shares);
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
  from_user_id: string; to_user_id: string; amount_base_minor: number; note?: string | null;
}, actorUserId: string): Promise<{ id: string }> {
  const amount = Math.round(Number(input.amount_base_minor) || 0);
  if (amount <= 0) throw new BadRequest("精算額は1以上にしてください");
  if (input.from_user_id === input.to_user_id) throw new BadRequest("送金元と送金先は別の参加者にしてください");
  const memberIds = await activeMemberSet(planId);
  assertMember(memberIds, String(input.from_user_id || ""), "送金元");
  assertMember(memberIds, String(input.to_user_id || ""), "送金先");
  assertMember(memberIds, actorUserId, "記録者");
  const id = newId("stl");
  await pool.query(
    `INSERT INTO settlements (id, plan_id, from_user_id, to_user_id, amount_base_minor, note, created_by_id)
     VALUES (?,?,?,?,?,?,?)`,
    [id, planId, input.from_user_id, input.to_user_id, amount, input.note || null, actorUserId],
  );
  return { id };
}

// ---- 友達 ---------------------------------------------------------------

export async function friendshipBetween(a: string, b: string): Promise<{
  id: string; requested_by_id: string; status: string;
} | null> {
  const [low, high] = friendshipPair(a, b);
  const rows = await all<{ id: string; requested_by_id: string; status: string }>(
    "SELECT id, requested_by_id, status FROM friendships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1",
    [low, high],
  );
  return rows[0] || null;
}

export async function upsertFriendship(input: {
  a: string; b: string; requested_by_id: string; status?: string;
}): Promise<{ id: string }> {
  const [low, high] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  const existing = await all<{ id: string }>(
    "SELECT id FROM friendships WHERE user_low_id = ? AND user_high_id = ? LIMIT 1", [low, high],
  );
  if (existing[0]) {
    await pool.query(
      `UPDATE friendships
          SET status = ?,
              requested_by_id = CASE WHEN ? = 'pending' THEN ? ELSE requested_by_id END,
              responded_at = CASE WHEN ? = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END
        WHERE id = ?`,
      [input.status || "pending", input.status || "pending", input.requested_by_id, input.status || "pending", existing[0].id],
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
