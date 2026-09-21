#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.shift() || "";
let tunnel = null;
let lockHeld = false;
const lockDir = resolve(tmpdir(), "tabi-plan-expense-data.lock");

function usage(message = "") {
  if (message) console.error(message);
  console.error(`Usage:
  npm run expense:data -- plans
  npm run expense:data -- members --plan <slug|title|id>
  npm run expense:data -- list --plan <slug|title|id> [--date YYYY-MM-DD]
  npm run expense:data -- import --file <expenses.json> [--commit]

Import file:
  {
    "plan": "2026-hong-kong-macau-kinmen",
    "actor": "合澤",
    "expenses": [
      {
        "paid_on": "2026-09-22",
        "title": "帰りの飛行機",
        "amount": 26240,
        "currency": "JPY",
        "payer": "合澤",
        "beneficiary": "合澤",
        "category": "transport",
        "payment_method": "card"
      }
    ]
  }

import は既定でdry-runです。内容を確認し、--commit を付けたときだけ保存します。
同じ日付、内容、金額、支払者、負担者の有効な費用は重複登録しません。`);
  process.exitCode = message ? 1 : 0;
}

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} に値が必要です`);
  return value;
}

function flag(name) {
  return args.includes(name);
}

function loadEnv() {
  const envPath = resolve(rootDir, process.env.ENV_FILE || ".env");
  if (!existsSync(envPath)) throw new Error(`${envPath} がありません`);
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    process.env[match[1]] = value;
  }
  process.env.SESSION_SECRET ||= "codex-local-expense-cli-session-secret";
}

function canConnect(host, port, timeoutMs = 700) {
  return new Promise((resolveConnection) => {
    const socket = net.createConnection({ host, port });
    const finish = (connected) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function acquireLock(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      lockHeld = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 5 * 60_000) {
          rmdirSync(lockDir);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  throw new Error("別の expense:data が実行中です。完了してからもう一度お試しください");
}

async function waitForPort(host, port, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnect(host, port)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`MySQLへ接続できません: ${host}:${port}`);
}

async function ensureTunnel() {
  const host = process.env.DB_HOST || "127.0.0.1";
  const port = Number(process.env.DB_PORT || 3310);
  if (await canConnect(host, port)) return;
  if (process.env.LOCAL_DB_TUNNEL === "0") {
    throw new Error(`MySQLへ接続できません: ${host}:${port}`);
  }
  const target = process.env.LOCAL_DB_SSH_TARGET;
  if (!target) throw new Error("LOCAL_DB_SSH_TARGET が .env に設定されていません");
  tunnel = spawn("ssh", [
    "-N", "-T",
    "-p", process.env.LOCAL_DB_SSH_PORT || "22",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-L", `${port}:${process.env.LOCAL_DB_REMOTE_HOST || "127.0.0.1"}:${process.env.LOCAL_DB_REMOTE_PORT || "3306"}`,
    target,
  ], { stdio: ["ignore", "ignore", "inherit"] });
  tunnel.once("error", (error) => {
    console.error(`SSHトンネルを起動できません: ${error.message}`);
  });
  await waitForPort(host, port);
}

function buildApi() {
  const result = spawnSync("npm", ["run", "build:api", "--silent"], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error("APIのビルドに失敗しました");
}

async function databaseModules() {
  loadEnv();
  await acquireLock();
  await ensureTunnel();
  buildApi();
  const db = await import(resolve(rootDir, "api/dist/db.js"));
  return {
    pool: db.pool,
    createExpense: (await import(resolve(rootDir, "api/dist/expense-repo.js"))).createExpense,
    close: () => db.closeDatabase(),
  };
}

async function resolvePlan(pool, query) {
  const [rows] = await pool.query(
    `SELECT id, slug, title, base_currency
       FROM plans
      WHERE deleted_at IS NULL AND (id = ? OR slug = ? OR title = ?)
      ORDER BY CASE WHEN id = ? THEN 0 WHEN slug = ? THEN 1 ELSE 2 END`,
    [query, query, query, query, query],
  );
  if (rows.length !== 1) {
    throw new Error(rows.length ? `旅行 ${query} が複数一致しました` : `旅行 ${query} が見つかりません`);
  }
  return rows[0];
}

async function planMembers(pool, planId) {
  const [rows] = await pool.query(
    `SELECT pm.user_id, pm.display_name, u.display_name AS account_name,
            pm.role, pm.status,
            CASE WHEN p.owner_user_id = pm.user_id THEN 'owner' ELSE pag.role END AS access_role,
            CASE WHEN p.owner_user_id = pm.user_id THEN 'active' ELSE pag.status END AS access_status
       FROM plan_members pm
       JOIN plans p ON p.id = pm.plan_id
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN plan_access_grants pag ON pag.plan_id = pm.plan_id AND pag.user_id = pm.user_id
      WHERE pm.plan_id = ? AND pm.status = 'active'
      ORDER BY pm.display_name, pm.user_id`,
    [planId],
  );
  return rows;
}

function resolvePerson(members, query, label, requireEditor = false) {
  let matches = members.filter((member) =>
    [member.user_id, member.display_name, member.account_name].includes(query));
  if (!matches.length) {
    // 旅行内表示が「姓 名」で一意なら、会話でよく使う姓だけでも指定できる。
    matches = members.filter((member) =>
      [member.display_name, member.account_name].some((name) =>
        String(name || "").startsWith(`${query} `) || String(name || "").startsWith(`${query}　`)));
  }
  const eligible = requireEditor
    ? matches.filter((member) => member.access_status === "active" && ["owner", "editor"].includes(member.access_role))
    : matches;
  if (eligible.length !== 1) {
    const reason = eligible.length ? "複数一致しました" : "一意に見つかりません";
    throw new Error(`${label} ${query} が${reason}`);
  }
  return eligible[0];
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} は1以上の整数で指定してください`);
  return number;
}

function normalizedInput(raw, plan, members) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expenses の各行はオブジェクトで指定してください");
  const currency = String(raw.currency || plan.base_currency || "JPY").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`通貨 ${currency} の形式が正しくありません`);
  if (currency !== "JPY" && raw.amount_minor === undefined) {
    throw new Error(`${currency} は amount ではなく最小通貨単位の amount_minor で指定してください`);
  }
  const amount = integer(raw.amount_minor ?? raw.amount, "金額");
  const rate = raw.fx_rate === undefined ? 1 : Number(raw.fx_rate);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("fx_rate は0より大きい数で指定してください");
  if (currency !== String(plan.base_currency).toUpperCase() && raw.fx_rate === undefined) {
    throw new Error(`${currency}から${plan.base_currency}への fx_rate が必要です`);
  }
  const payer = resolvePerson(members, String(raw.payer || ""), "支払者");
  const beneficiary = resolvePerson(members, String(raw.beneficiary || ""), "負担者");
  const paidOn = String(raw.paid_on || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) throw new Error("paid_on は YYYY-MM-DD で指定してください");
  const title = String(raw.title || "").trim();
  if (!title) throw new Error("title が必要です");
  const amountBase = Math.round(amount * rate);
  const selfPaid = payer.user_id === beneficiary.user_id;
  return {
    input: {
      paid_on: paidOn,
      payer_user_id: payer.user_id,
      category: String(raw.category || "other"),
      title,
      amount_minor: amount,
      currency,
      fx_rate: rate,
      split_method: selfPaid ? "none" : "equal_selected",
      payment_method: raw.payment_method ? String(raw.payment_method) : null,
      note: raw.note ? String(raw.note) : null,
      receipt_url: raw.receipt_url ? String(raw.receipt_url) : null,
      shares: selfPaid ? [] : [{ user_id: beneficiary.user_id, amount_base_minor: amountBase }],
    },
    payer_name: payer.display_name,
    beneficiary_name: beneficiary.display_name,
    amount_base_minor: amountBase,
  };
}

async function findDuplicate(pool, planId, item) {
  const input = item.input;
  const [rows] = await pool.query(
    `SELECT e.id, e.split_method,
            GROUP_CONCAT(CONCAT(s.user_id, ':', s.amount_base_minor) ORDER BY s.user_id SEPARATOR ',') AS shares
       FROM expenses e
       LEFT JOIN expense_shares s ON s.expense_id = e.id
      WHERE e.plan_id = ? AND e.deleted_at IS NULL AND e.paid_on = ?
        AND e.payer_user_id = ? AND e.title = ? AND e.amount_minor = ?
        AND e.currency = ? AND COALESCE(e.payment_method, '') = COALESCE(?, '')
      GROUP BY e.id, e.split_method
      ORDER BY e.created_at DESC`,
    [planId, input.paid_on, input.payer_user_id, input.title, input.amount_minor, input.currency, input.payment_method],
  );
  const expectedShares = input.shares
    .map((share) => `${share.user_id}:${share.amount_base_minor}`)
    .sort()
    .join(",");
  return rows.find((row) => row.split_method === input.split_method && String(row.shares || "") === expectedShares) || null;
}

function summary(item, extra = {}) {
  return {
    paid_on: item.input.paid_on,
    title: item.input.title,
    amount: item.input.amount_minor,
    currency: item.input.currency,
    payer: item.payer_name,
    beneficiary: item.beneficiary_name,
    category: item.input.category,
    payment_method: item.input.payment_method,
    ...extra,
  };
}

async function membersCommand() {
  const query = option("--plan");
  if (!query) throw new Error("--plan が必要です");
  const modules = await databaseModules();
  try {
    const plan = await resolvePlan(modules.pool, query);
    console.log(JSON.stringify({ plan, members: await planMembers(modules.pool, plan.id) }, null, 2));
  } finally {
    await modules.close();
  }
}

async function plansCommand() {
  const modules = await databaseModules();
  try {
    const [rows] = await modules.pool.query(
      `SELECT p.id, p.slug, p.title, p.start_date, p.end_date, p.base_currency,
              GROUP_CONCAT(pm.display_name ORDER BY pm.display_name SEPARATOR ', ') AS members
         FROM plans p
         LEFT JOIN plan_members pm ON pm.plan_id = p.id AND pm.status = 'active'
        WHERE p.deleted_at IS NULL
        GROUP BY p.id
        ORDER BY COALESCE(p.start_date, '9999-12-31'), p.title`,
    );
    console.log(JSON.stringify({ plans: rows }, null, 2));
  } finally {
    await modules.close();
  }
}

async function listCommand() {
  const query = option("--plan");
  if (!query) throw new Error("--plan が必要です");
  const modules = await databaseModules();
  try {
    const plan = await resolvePlan(modules.pool, query);
    const date = option("--date");
    const params = [plan.id];
    const dateClause = date ? "AND e.paid_on = ?" : "";
    if (date) params.push(date);
    const [rows] = await modules.pool.query(
      `SELECT e.id, e.paid_on, e.title, e.amount_minor, e.currency, e.fx_rate,
              e.amount_base_minor, e.category, e.payment_method, e.split_method,
              payer.display_name AS payer,
              GROUP_CONCAT(beneficiary.display_name ORDER BY beneficiary.display_name SEPARATOR ', ') AS beneficiaries,
              e.created_at
         FROM expenses e
         JOIN plan_members payer ON payer.plan_id = e.plan_id AND payer.user_id = e.payer_user_id
         LEFT JOIN expense_shares s ON s.expense_id = e.id
         LEFT JOIN plan_members beneficiary ON beneficiary.plan_id = e.plan_id AND beneficiary.user_id = s.user_id
        WHERE e.plan_id = ? AND e.deleted_at IS NULL ${dateClause}
        GROUP BY e.id, payer.display_name
        ORDER BY e.paid_on, e.created_at`,
      params,
    );
    console.log(JSON.stringify({ plan, expenses: rows }, null, 2));
  } finally {
    await modules.close();
  }
}

async function importCommand() {
  const file = option("--file");
  if (!file) throw new Error("--file が必要です");
  const batch = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (!batch.plan || !batch.actor || !Array.isArray(batch.expenses) || !batch.expenses.length) {
    throw new Error("plan、actor、1件以上のexpensesが必要です");
  }
  const modules = await databaseModules();
  try {
    const plan = await resolvePlan(modules.pool, String(batch.plan));
    const members = await planMembers(modules.pool, plan.id);
    const actor = resolvePerson(members, String(batch.actor), "記録者", true);
    const normalized = batch.expenses.map((row) => normalizedInput(row, plan, members));
    const seen = new Set();
    for (const item of normalized) {
      const key = JSON.stringify(item.input);
      if (seen.has(key)) throw new Error(`入力内で費用が重複しています: ${item.input.title}`);
      seen.add(key);
    }

    const planned = [];
    const skipped = [];
    for (const item of normalized) {
      const duplicate = await findDuplicate(modules.pool, plan.id, item);
      if (duplicate) skipped.push(summary(item, { status: "duplicate", id: duplicate.id }));
      else planned.push(item);
    }
    console.error(JSON.stringify({
      plan: { id: plan.id, slug: plan.slug, title: plan.title },
      actor: { user_id: actor.user_id, display_name: actor.display_name },
      commit: flag("--commit"),
      add: planned.map((item) => summary(item)),
      skip: skipped,
    }, null, 2));

    if (!flag("--commit")) {
      console.error("dry-run: 検査のみ。保存するには --commit を付けます");
      return;
    }

    const saved = [];
    for (const item of planned) {
      // 直前にも再確認する。応答消失後の再実行や並行追加で同じ費用を二重登録しない。
      const duplicate = await findDuplicate(modules.pool, plan.id, item);
      if (duplicate) {
        saved.push(summary(item, { status: "duplicate", id: duplicate.id }));
        continue;
      }
      const result = await modules.createExpense(plan.id, item.input, actor.user_id);
      const [verifiedRows] = await modules.pool.query(
        `SELECT e.id
           FROM expenses e
           JOIN expense_audit_logs a ON a.expense_id = e.id AND a.action = 'create'
          WHERE e.id = ? AND e.plan_id = ? AND e.deleted_at IS NULL AND a.actor_user_id = ?`,
        [result.id, plan.id, actor.user_id],
      );
      if (verifiedRows.length !== 1) throw new Error(`保存後の確認に失敗しました: ${result.id}`);
      saved.push(summary(item, { status: "saved", id: result.id }));
    }
    console.log(JSON.stringify({ saved, skipped }, null, 2));
  } finally {
    await modules.close();
  }
}

async function main() {
  if (["", "help", "--help", "-h"].includes(command)) {
    usage();
    return;
  }
  if (command === "plans") await plansCommand();
  else if (command === "members") await membersCommand();
  else if (command === "list") await listCommand();
  else if (command === "import") await importCommand();
  else throw new Error(`不明なコマンドです: ${command}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (tunnel && !tunnel.killed) tunnel.kill("SIGTERM");
  if (lockHeld) {
    try {
      rmdirSync(lockDir);
    } catch (error) {
      if (error?.code !== "ENOENT") console.error(`一時ロックを解除できません: ${error.message}`);
    }
  }
}
