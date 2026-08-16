#!/usr/bin/env node
// kv_store の JSON を 002_relational.sql のテーブルへ移す一回きりの移行。
//
// 同じデータベース内で完結するので API は経由しない。1トランザクションで入れ、
// 失敗したら全部戻す。--reset を付けると移行先を空にしてから入れ直す（冪等に再実行できる）。
//
// 使い方（サーバー上、または SSH トンネル越しに）:
//   set -a; . ~/secure_env/travel-api.env; set +a
//   node api/scripts/migrate-kv-to-relational.mjs --reset
//
// 人の同定について:
//   計画の members / 費用の支払者 / 候補の投票者はすべて「表示名の文字列」なので、
//   同じ名前は同一人物として users 1行に寄せる。アカウントがある名前はその id を使う。
//   （trip-10 の「かな」と trip-12 の「かな」を同じ人とみなす前提）

import mysql from "mysql2/promise";

const RESET = process.argv.includes("--reset");
const DRY = process.argv.includes("--dry-run");

const conn = await mysql.createConnection({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "TravelPlan",
  charset: "utf8mb4",
  multipleStatements: false,
});

// ---- ID 採番 -------------------------------------------------------------

let seq = 0;
const stamp = Date.now().toString(36);
const newId = (prefix) => `${prefix}_${stamp}${(seq++).toString(36).padStart(3, "0")}`;

// ---- 値の変換 ------------------------------------------------------------

const SPLIT_METHOD = {
  "全員で等分": "equal_all",
  "選んだ人だけで等分": "equal_selected",
  "個別金額を入力": "custom",
  "精算不要": "none",
};
const CATEGORY = {
  食費: "food", 交通: "transport", 宿泊: "lodging",
  観光: "sightseeing", 通信: "communication", その他: "other",
};
const PAYMENT_METHOD = { カード: "card", 現金: "cash", 送金: "transfer", その他: "other" };
const SOURCE = {
  local: "local", googleSheets: "google_sheets", appsScript: "apps_script", sample: "sample",
};
const KIND = new Set(["sight", "move", "food", "stay", "todo", "form"]);

const nameKey = (s) => String(s || "").trim().toLowerCase();
const splitNames = (s) =>
  String(s || "").split(/[、,／/]|\s*\/\s*|\s*･\s*/).map((x) => x.trim()).filter(Boolean);

/** '2026/7/1 - 2026/7/3' / '2026-08-01 - 2026-08-09' / '2026年8月' を解釈する。 */
function parseDates(raw) {
  const s = String(raw || "").trim();
  if (!s) return { start: null, end: null, label: null };
  const iso = (y, m, d) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const one = (part) => {
    let m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(part.trim());
    if (m) return iso(m[1], m[2], m[3]);
    m = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(part.trim());
    if (m) return iso(m[1], m[2], m[3]);
    return null;
  };
  const parts = s.split(/\s*[-–~〜]\s*/);
  if (parts.length === 2) {
    const a = one(parts[0]);
    const b = one(parts[1]);
    if (a && b) return { start: a, end: b, label: null };
  }
  const single = one(s);
  if (single) return { start: single, end: single, label: null };
  // '2026年8月' のように日が無いものは構造化できないのでラベルとして残す
  return { start: null, end: null, label: s.slice(0, 64) };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const b64 = (s) => Buffer.from(String(s || ""), "base64");
const ts = (v) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 19).replace("T", " ") : null;
};

// ---- 読み込み ------------------------------------------------------------

const [rows] = await conn.query("SELECT k, v FROM kv_store WHERE scope = 'default'");
const store = {};
for (const r of rows) store[r.k] = typeof r.v === "string" ? JSON.parse(r.v) : r.v;
console.log(`kv_store から ${Object.keys(store).length} キー読み込み`);

const planMetas = store["trip-dashboard-plans"] || [];
const accounts = store["trip-dashboard-accounts"] || [];
const permissions = store["trip-dashboard-permissions"] || { planPermissions: [], planInvites: [] };
const friendships = (store["trip-dashboard-friendships"] || {}).friendRequests || [];
const views = store["trip-dashboard-views"] || {};
const payLinks = store["trip-dashboard-pay-links"] || {};
const privacy = store["trip-dashboard-history-privacy"] || {};
const planData = (slug) => store[`trip-dashboard-plan-${slug}`] || null;
const expensesOf = (slug) => store[`trip-dashboard-expenses-${slug}`] || [];

// ---- users を組み立てる --------------------------------------------------
// アカウントを優先し、名前しか無い参加者も users 行として作る。

const usersByKey = new Map(); // name_key -> {id, display_name, credentials?}

function ensureUserByName(name) {
  const key = nameKey(name);
  if (!key) return null;
  if (usersByKey.has(key)) return usersByKey.get(key);
  const row = { id: newId("usr"), display_name: String(name).trim().slice(0, 64), key };
  usersByKey.set(key, row);
  return row;
}

// 1) アカウント（既存 id を引き継ぐ）
const usersById = new Map();
for (const a of accounts) {
  const key = nameKey(a.name);
  const row = {
    id: a.id,
    display_name: String(a.name || a.email || "?").slice(0, 64),
    key,
    createdAt: ts(a.createdAt),
    cred: { email: String(a.email || "").toLowerCase(), salt: b64(a.salt), hash: b64(a.hash) },
  };
  usersById.set(a.id, row);
  // 同名が複数ある場合、名前引きは最初のアカウントに寄せる
  if (key && !usersByKey.has(key)) usersByKey.set(key, row);
}

// 2) 名前しか無い人を拾う（メンバー・支払者・投票者・精算相手・権限行）
for (const p of planMetas) splitNames(p.members).forEach(ensureUserByName);
for (const r of permissions.planPermissions || []) {
  if (r.subjectType === "name") ensureUserByName(r.subjectId);
}
for (const p of planMetas) {
  for (const e of expensesOf(p.slug)) {
    ensureUserByName(e.payer);
    (e.targets || []).forEach(ensureUserByName);
    Object.keys(e.individual || {}).forEach(ensureUserByName);
  }
  const data = planData(p.slug);
  for (const c of (data && data.candidates) || []) {
    ensureUserByName(c.proposer);
    (c.votes || []).forEach(ensureUserByName);
  }
}
Object.keys(payLinks).forEach(ensureUserByName);
Object.keys(privacy).forEach(ensureUserByName);
for (const f of friendships) {
  if (f.fromAccountId && !usersById.has(f.fromAccountId)) ensureUserByName(f.fromName);
  if (f.toAccountId && !usersById.has(f.toAccountId)) ensureUserByName(f.toName);
}

const allUsers = new Map(); // id -> row
for (const row of usersById.values()) allUsers.set(row.id, row);
for (const row of usersByKey.values()) if (!allUsers.has(row.id)) allUsers.set(row.id, row);
const userIdByName = (name) => {
  const key = nameKey(name);
  const row = key ? usersByKey.get(key) : null;
  return row ? row.id : null;
};

console.log(`users: ${allUsers.size}人（アカウント ${accounts.length}件 / 名前のみ ${allUsers.size - accounts.length}人）`);

// ---- 書き込み ------------------------------------------------------------

if (DRY) {
  console.log("--dry-run なので書き込みません。");
  await conn.end();
  process.exit(0);
}

await conn.beginTransaction();
try {
  if (RESET) {
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const t of [
      "expense_audit_logs", "expense_shares", "expenses", "settlements", "plan_candidate_votes", "plan_candidates",
      "plan_checklist_items", "plan_links", "plan_cities", "itinerary_items", "plan_view_daily",
      "plan_invites", "plan_members", "plans", "user_settings", "user_payment_links",
      "friendships", "user_sessions", "user_credentials", "users",
    ]) await conn.query(`DELETE FROM ${t}`);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
  }

  const insert = async (sql, values) => {
    if (!values.length) return 0;
    await conn.query(sql, [values]);
    return values.length;
  };

  // users / credentials
  await insert(
    "INSERT INTO users (id, display_name, name_key, created_at) VALUES ?",
    [...allUsers.values()].map((u) => [u.id, u.display_name, u.key, u.createdAt || new Date()]),
  );
  await insert(
    "INSERT INTO user_credentials (user_id, email, password_salt, password_hash) VALUES ?",
    [...allUsers.values()].filter((u) => u.cred).map((u) => [u.id, u.cred.email, u.cred.salt, u.cred.hash]),
  );

  // 送金リンク / 設定
  await insert(
    "INSERT INTO user_payment_links (user_id, provider, handle) VALUES ?",
    Object.entries(payLinks)
      .map(([name, v]) => [userIdByName(name), "paypay", String((v || {}).paypay || "")])
      .filter(([id, , h]) => id && h),
  );
  await insert(
    "INSERT INTO user_settings (user_id, history_public) VALUES ?",
    Object.entries(privacy)
      .map(([name, pub]) => [userIdByName(name), pub ? 1 : 0])
      .filter(([id]) => id),
  );

  // 友達関係（low/high 順に正規化して重複を落とす）
  const seenPair = new Set();
  const friendRows = [];
  for (const f of friendships) {
    const a = usersById.has(f.fromAccountId) ? f.fromAccountId : userIdByName(f.fromName);
    const b = usersById.has(f.toAccountId) ? f.toAccountId : userIdByName(f.toName);
    if (!a || !b || a === b) continue;
    const [low, high] = a < b ? [a, b] : [b, a];
    if (seenPair.has(`${low}|${high}`)) continue;
    seenPair.add(`${low}|${high}`);
    friendRows.push([newId("frd"), low, high, a, f.status || "pending", ts(f.createdAt) || new Date(), ts(f.respondedAt)]);
  }
  await insert(
    "INSERT INTO friendships (id, user_low_id, user_high_id, requested_by_id, status, created_at, responded_at) VALUES ?",
    friendRows,
  );

  // plans
  const planIdBySlug = new Map();
  const ownerBySlug = new Map();
  for (const r of permissions.planPermissions || []) {
    if (r.role === "owner" && r.subjectType === "account") ownerBySlug.set(r.planSlug, r.subjectId);
  }
  const planRows = [];
  for (const p of planMetas) {
    const id = newId("pln");
    planIdBySlug.set(p.slug, id);
    const { start, end, label } = parseDates(p.dates);
    planRows.push([
      id, p.slug, String(p.title || "無題の旅行").slice(0, 120), p.note || null,
      start, end, label, p.cover || null, "JPY",
      SOURCE[p.source] || "local",
      p.visibility === "invite" ? "invite" : "public",
      p.published === false ? "draft" : "published",
      0,
      ownerBySlug.get(p.slug) || null,
      p.spreadsheetId || null, p.appsScriptUrl || null, p.schema || null,
      ts(p.createdAt) || new Date(), ts(p.updatedAt) || new Date(),
    ]);
  }
  await insert(
    `INSERT INTO plans (id, slug, title, note, start_date, end_date, dates_label, cover_url,
       base_currency, source, visibility, status, open_editing, owner_user_id,
       external_spreadsheet_id, external_apps_script_url, external_schema, created_at, updated_at) VALUES ?`,
    planRows,
  );

  // plan_members（members 文字列 + 権限行を統合）
  const memberRows = new Map(); // `${plan}|${user}` -> row
  const putMember = (slug, userId, role) => {
    const planId = planIdBySlug.get(slug);
    if (!planId || !userId) return;
    const key = `${planId}|${userId}`;
    const rank = { viewer: 1, editor: 2, owner: 3 };
    const prev = memberRows.get(key);
    if (prev && rank[prev[2]] >= rank[role]) return;
    memberRows.set(key, [planId, userId, role, "active"]);
  };
  for (const p of planMetas) {
    for (const n of splitNames(p.members)) putMember(p.slug, userIdByName(n), "editor");
    const owner = ownerBySlug.get(p.slug);
    if (owner) putMember(p.slug, owner, "owner");
  }
  for (const r of permissions.planPermissions || []) {
    if (r.status !== "active") continue;
    const uid = r.subjectType === "account" ? r.subjectId : userIdByName(r.subjectId);
    putMember(r.planSlug, uid, r.role);
  }
  await insert("INSERT INTO plan_members (plan_id, user_id, role, status) VALUES ?", [...memberRows.values()]);

  // 計画本体（行程・都市・リンク・チェックリスト・候補）
  const itinRows = [], cityRows = [], linkRows = [], checkRows = [], candRows = [], voteRows = [];
  for (const p of planMetas) {
    const planId = planIdBySlug.get(p.slug);
    const data = planData(p.slug);
    if (!planId || !data) continue;
    (data.itinerary || []).forEach((it, i) => {
      itinRows.push([
        newId("itm"), planId,
        /^\d{4}-\d{2}-\d{2}/.test(String(it.date || "")) ? String(it.date).slice(0, 10) : null,
        num(it.day), i,
        KIND.has(it.type) ? it.type : "sight",
        /^\d{1,2}:\d{2}/.test(String(it.time || "")) ? String(it.time).slice(0, 5) + ":00" : null,
        String(it.title || "").slice(0, 200), (it.place || null) && String(it.place).slice(0, 200),
        (it.area || null) && String(it.area).slice(0, 100), it.note || null,
        (it.mapQuery || null) && String(it.mapQuery).slice(0, 200),
        num(it.lat), num(it.lng),
      ]);
    });
    (data.cities || []).forEach((c, i) => {
      const name = typeof c === "string" ? c : c && c.name;
      if (name) cityRows.push([newId("cty"), planId, String(name).slice(0, 100), i]);
    });
    const seenLink = new Set();
    (data.links || []).forEach((l, i) => {
      const key = String((l && l.key) || `link${i}`).slice(0, 40);
      if (!l || !l.url || seenLink.has(key)) return;
      seenLink.add(key);
      linkRows.push([newId("lnk"), planId, key, String(l.label || key).slice(0, 80), String(l.url).slice(0, 1024), (l.caption || null) && String(l.caption).slice(0, 80), i]);
    });
    (data.checklist || []).forEach((c, i) => {
      if (!c || !c.label) return;
      const status = c.status === "doing" ? "doing" : c.done || c.status === "done" ? "done" : "todo";
      checkRows.push([newId("chk"), planId, String(c.label).slice(0, 200), status, i]);
    });
    (data.candidates || []).forEach((c) => {
      if (!c || !c.title) return;
      const cid = newId("cnd");
      candRows.push([cid, planId, String(c.title).slice(0, 200), (c.place || null) && String(c.place).slice(0, 200), userIdByName(c.proposer), c.adopted ? new Date() : null, ts(c.createdAt) || new Date()]);
      const seenVote = new Set();
      (c.votes || []).forEach((v) => {
        const uid = userIdByName(v);
        if (!uid || seenVote.has(uid)) return;
        seenVote.add(uid);
        voteRows.push([cid, uid]);
      });
    });
  }
  await insert(
    `INSERT INTO itinerary_items (id, plan_id, item_date, day_index, sort_order, kind, start_time,
       title, place, area, note, map_query, lat, lng) VALUES ?`, itinRows);
  await insert("INSERT INTO plan_cities (id, plan_id, name, sort_order) VALUES ?", cityRows);
  await insert("INSERT INTO plan_links (id, plan_id, link_key, label, url, caption, sort_order) VALUES ?", linkRows);
  await insert("INSERT INTO plan_checklist_items (id, plan_id, label, status, sort_order) VALUES ?", checkRows);
  await insert("INSERT INTO plan_candidates (id, plan_id, title, place, proposed_by_id, adopted_at, created_at) VALUES ?", candRows);
  await insert("INSERT INTO plan_candidate_votes (candidate_id, user_id) VALUES ?", voteRows);

  // 閲覧数（旧構造は合計のみなので、移行日に1行として入れる）
  const today = new Date().toISOString().slice(0, 10);
  await insert(
    "INSERT INTO plan_view_daily (plan_id, viewed_on, view_count) VALUES ?",
    Object.entries(views)
      .map(([slug, n]) => [planIdBySlug.get(slug), today, Math.max(0, Math.floor(Number(n) || 0))])
      .filter(([id]) => id),
  );

  // 費用・負担・精算
  const expRows = [], shareRows = [], stlRows = [];
  let skipped = 0;
  for (const p of planMetas) {
    const planId = planIdBySlug.get(p.slug);
    if (!planId) continue;
    const participants = splitNames(p.members).map(userIdByName).filter(Boolean);
    for (const e of expensesOf(p.slug)) {
      const payer = userIdByName(e.payer);
      if (!payer) { skipped += 1; continue; }
      const amount = Math.round(Number(e.amount) || 0);

      if (e.kind === "settlement") {
        const to = userIdByName((e.targets || [])[0]);
        if (!to || to === payer || amount <= 0) { skipped += 1; continue; }
        stlRows.push([newId("stl"), planId, payer, to, amount, e.note || null, ts(e.createdAt) || new Date()]);
        continue;
      }

      const method = SPLIT_METHOD[e.splitMode] || "equal_all";
      // 負担額を確定させる。等分の端数は先頭の人に寄せ、合計＝支払額にする。
      let shares = [];
      if (method === "none") {
        shares = [];
      } else if (method === "custom") {
        shares = Object.entries(e.individual || {})
          .map(([n, v]) => [userIdByName(n), Math.round(Number(v) || 0)])
          .filter(([id, v]) => id && v > 0);
      } else {
        const targets = method === "equal_selected" && (e.targets || []).length
          ? (e.targets || []).map(userIdByName).filter(Boolean)
          : participants.length ? participants : [payer];
        const uniq = [...new Set(targets)];
        if (uniq.length) {
          const base = Math.floor(amount / uniq.length);
          let rest = amount - base * uniq.length;
          shares = uniq.map((id, i) => [id, base + (i < rest ? 1 : 0)]);
        }
      }
      const id = e.id && /^[\w-]{1,32}$/.test(e.id) ? e.id : newId("exp");
      expRows.push([
        id, planId,
        /^\d{4}-\d{2}-\d{2}/.test(String(e.paidDate || "")) ? String(e.paidDate).slice(0, 10) : null,
        payer, CATEGORY[e.category] || "other", String(e.title || "").slice(0, 200),
        amount, String(e.currency || "JPY").toUpperCase().slice(0, 3), 1, amount,
        method, PAYMENT_METHOD[e.paymentMethod] || null,
        e.note || null, e.receiptUrl || null, ts(e.createdAt) || new Date(),
      ]);
      for (const [uid, v] of shares) if (v > 0) shareRows.push([id, uid, v]);
    }
  }
  await insert(
    `INSERT INTO expenses (id, plan_id, paid_on, payer_user_id, category, title, amount_minor,
       currency, fx_rate, amount_base_minor, split_method, payment_method, note, receipt_url, created_at) VALUES ?`,
    expRows);
  await insert("INSERT INTO expense_shares (expense_id, user_id, amount_base_minor) VALUES ?", shareRows);
  await insert("INSERT INTO settlements (id, plan_id, from_user_id, to_user_id, amount_base_minor, note, settled_at) VALUES ?", stlRows);

  await conn.commit();
  console.log(`
移行完了
  users            ${allUsers.size}
  user_credentials ${[...allUsers.values()].filter((u) => u.cred).length}
  friendships      ${friendRows.length}
  plans            ${planRows.length}
  plan_members     ${memberRows.size}
  itinerary_items  ${itinRows.length}
  plan_cities      ${cityRows.length}
  plan_links       ${linkRows.length}
  checklist        ${checkRows.length}
  candidates       ${candRows.length} (votes ${voteRows.length})
  expenses         ${expRows.length} (shares ${shareRows.length})
  settlements      ${stlRows.length}
  取り込めず飛ばした費用: ${skipped}`);
} catch (error) {
  await conn.rollback();
  console.error("移行に失敗したのでロールバックしました:", error.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
