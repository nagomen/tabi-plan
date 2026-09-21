#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args.shift() || "";

function usage(message = "") {
  if (message) console.error(message);
  console.error(`Usage:
  npm run plan:data -- public-export --plan <slug|title|id> [--out <file>]
  npm run plan:data -- db-actors --plan <slug|title|id>
  npm run plan:data -- db-export --plan <slug|title|id> --actor <user_id> [--out <file>]
  npm run plan:data -- db-apply --file <database-export.json> --actor <user_id> [--commit]`);
  process.exit(message ? 1 : 0);
}

function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`${name} に値が必要です`);
  return value;
}

function flag(name) {
  return args.includes(name);
}

function loadEnv() {
  const envPath = resolve(rootDir, ".env");
  if (!existsSync(envPath)) usage(".env がありません");
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
  process.env.SESSION_SECRET ||= "codex-local-data-cli-session-secret-only";
}

function targetPlan(plans, query) {
  const matches = plans.filter((plan) => [plan.id, plan.slug, plan.title].includes(query));
  if (matches.length !== 1) {
    const label = matches.length ? "複数一致しました" : "見つかりません";
    usage(`旅行 ${query} が${label}`);
  }
  return matches[0];
}

const without = (row, fields) => Object.fromEntries(
  Object.entries(row).filter(([key]) => !fields.includes(key)),
);

function snapshot(bootstrap, plan, scope, actor = "") {
  const inPlan = (row) => row.plan_id === plan.id;
  const candidates = bootstrap.candidates.filter(inPlan).map((candidate) => {
    const votes = bootstrap.candidateVotes
      .filter((vote) => vote.candidate_id === candidate.id)
      .map((vote) => vote.user_id)
      .sort();
    return {
      ...without(candidate, ["plan_id", "created_at", "adopted_at"]),
      adopted: Boolean(candidate.adopted_at),
      votes,
    };
  });
  const content = {
    itinerary: bootstrap.itinerary.filter(inPlan).map((row) =>
      without(row, ["id", "plan_id", "sort_order"])),
    cities: bootstrap.cities.filter(inPlan).map((row) =>
      without(row, ["id", "plan_id", "sort_order"])),
  };
  if (scope === "database") {
    content.links = bootstrap.links.filter(inPlan).map((row) =>
      without(row, ["id", "plan_id", "sort_order"]));
    content.checklist = bootstrap.checklist.filter(inPlan).map((row) =>
      without(row, ["id", "plan_id", "sort_order"]));
    content.candidates = candidates;
  }
  return {
    schema_version: 1,
    scope,
    exported_at: new Date().toISOString(),
    actor_user_id: actor || null,
    plan,
    content,
  };
}

function output(value, path = "") {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  if (!path) process.stdout.write(json);
  else {
    writeFileSync(resolve(path), json, { mode: 0o600 });
    console.error(`saved: ${resolve(path)}`);
  }
}

function publicApiBase() {
  const config = readFileSync(resolve(rootDir, "frontend/public/trip-config.js"), "utf8");
  const match = /apiBaseUrl:\s*["']([^"']+)["']/.exec(config);
  if (!match) usage("trip-config.js の apiBaseUrl を確認できません");
  return match[1].replace(/\/+$/, "");
}

async function publicExport() {
  const query = option("--plan");
  if (!query) usage("--plan が必要です");
  const response = await fetch(`${publicApiBase()}/api/bootstrap`);
  if (!response.ok) throw new Error(`公開APIの取得に失敗しました: HTTP ${response.status}`);
  const bootstrap = await response.json();
  const plan = targetPlan(bootstrap.plans, query);
  output(snapshot(bootstrap, plan, "public"), option("--out"));
}

async function databaseModules() {
  loadEnv();
  const bootstrapPath = resolve(rootDir, "api/dist/bootstrap-repo.js");
  const planPath = resolve(rootDir, "api/dist/plan-repo.js");
  if (!existsSync(bootstrapPath) || !existsSync(planPath)) {
    usage("先に npm run build:api を実行してください");
  }
  const db = await import(resolve(rootDir, "api/dist/db.js"));
  return {
    bootstrapForUser: (await import(bootstrapPath)).bootstrapForUser,
    planRepo: await import(planPath),
    pool: db.pool,
    closePool: async () => db.pool.end(),
  };
}

async function databasePlan(pool, query) {
  const [rows] = await pool.query(
    `SELECT id, slug, title, note, start_date, end_date, dates_label, cover_url,
            base_currency, source, visibility, status, version, open_editing, owner_user_id,
            created_at, updated_at
       FROM plans
      WHERE deleted_at IS NULL AND (id = ? OR slug = ? OR title = ?)
      ORDER BY CASE WHEN id = ? THEN 0 WHEN slug = ? THEN 1 ELSE 2 END`,
    [query, query, query, query, query],
  );
  return targetPlan(rows, query);
}

function assertEditorAccess(bootstrap, planId, actor) {
  const access = bootstrap.members.find((member) =>
    member.plan_id === planId && member.user_id === actor && member.access_status === "active" &&
    ["owner", "editor"].includes(member.role));
  if (!access) usage("指定actorは対象旅行の有効なowner/editorではありません");
}

async function dbActors() {
  const query = option("--plan");
  if (!query) usage("--plan が必要です");
  const modules = await databaseModules();
  try {
    const plan = await databasePlan(modules.pool, query);
    const [rows] = await modules.pool.query(
      `SELECT u.id, u.display_name,
              CASE WHEN p.owner_user_id = u.id THEN 'owner' ELSE pag.role END AS role
         FROM plans p
         JOIN plan_access_grants pag ON pag.plan_id = p.id
              AND pag.status = 'active' AND pag.role IN ('owner', 'editor')
         JOIN users u ON u.id = pag.user_id
        WHERE p.id = ? AND p.deleted_at IS NULL
        ORDER BY role, u.display_name`,
      [plan.id],
    );
    output({ plan: { id: plan.id, slug: plan.slug, title: plan.title }, actors: rows });
  } finally {
    await modules.closePool();
  }
}

async function dbExport() {
  const query = option("--plan");
  const actor = option("--actor");
  if (!query || !actor) usage("--plan と --actor が必要です");
  const modules = await databaseModules();
  try {
    const plan = await databasePlan(modules.pool, query);
    const bootstrap = await modules.bootstrapForUser(actor);
    const visiblePlan = targetPlan(bootstrap.plans, plan.id);
    assertEditorAccess(bootstrap, visiblePlan.id, actor);
    output(snapshot(bootstrap, visiblePlan, "database", actor), option("--out"));
  } finally {
    await modules.closePool();
  }
}

function contentDiff(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => {
    const beforeRows = Array.isArray(before[key]) ? before[key] : [];
    const afterRows = Array.isArray(after[key]) ? after[key] : [];
    const changedRows = [];
    for (let index = 0; index < Math.min(beforeRows.length, afterRows.length); index += 1) {
      if (JSON.stringify(beforeRows[index]) !== JSON.stringify(afterRows[index])) changedRows.push(index + 1);
    }
    return [key, {
      before: beforeRows.length,
      after: afterRows.length,
      added: Math.max(0, afterRows.length - beforeRows.length),
      removed: Math.max(0, beforeRows.length - afterRows.length),
      changed_rows: changedRows.slice(0, 50),
    }];
  }));
}

function hasChanges(diff) {
  return Object.values(diff).some((entry) =>
    entry.added || entry.removed || entry.changed_rows.length);
}

async function dbApply() {
  const file = option("--file");
  const actor = option("--actor");
  if (!file || !actor) usage("--file と --actor が必要です");
  const proposed = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (proposed.schema_version !== 1 || proposed.scope !== "database") {
    usage("db-export で作成した scope=database のJSONだけを適用できます");
  }
  if (proposed.actor_user_id !== actor) usage("エクスポート時と同じ --actor を指定してください");
  if (!proposed.plan?.id || !proposed.content || typeof proposed.content !== "object") {
    usage("エクスポートJSONの形式が正しくありません");
  }
  const modules = await databaseModules();
  try {
    modules.planRepo.validatePlanContent(proposed.content);
    const databasePlanRow = await databasePlan(modules.pool, proposed.plan.id);
    const currentBootstrap = await modules.bootstrapForUser(actor);
    const currentPlan = targetPlan(currentBootstrap.plans, databasePlanRow.id);
    assertEditorAccess(currentBootstrap, currentPlan.id, actor);
    const current = snapshot(currentBootstrap, currentPlan, "database", actor);
    const diff = contentDiff(current.content, proposed.content);
    console.error(JSON.stringify({
      plan: { id: currentPlan.id, slug: currentPlan.slug, title: currentPlan.title },
      expected_version: proposed.plan.version,
      current_version: currentPlan.version,
      changes: diff,
      commit: flag("--commit"),
    }, null, 2));
    if (Number(currentPlan.version) !== Number(proposed.plan.version)) {
      usage("DBの版が進んでいます。新しくdb-exportして差分を作り直してください");
    }
    if (!hasChanges(diff)) {
      console.error("no-op: 変更はありません");
      return;
    }
    if (!flag("--commit")) {
      console.error("dry-run: 検査のみ。反映するには --commit を付けます");
      return;
    }
    const backupDir = resolve(rootDir, ".codex-data-backups");
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = resolve(backupDir, `${currentPlan.slug}-${stamp}.json`);
    output(current, backupPath);
    const version = await modules.planRepo.replacePlanContent(
      currentPlan.id, proposed.content, Number(currentPlan.version), actor,
    );
    const verifiedBootstrap = await modules.bootstrapForUser(actor);
    const verifiedPlan = targetPlan(verifiedBootstrap.plans, currentPlan.id);
    const verified = snapshot(verifiedBootstrap, verifiedPlan, "database", actor);
    const verificationDiff = contentDiff(proposed.content, verified.content);
    if (Number(verifiedPlan.version) !== version || hasChanges(verificationDiff)) {
      throw new Error(`反映後の再取得が一致しません。バックアップを確認してください: ${backupPath}`);
    }
    console.error(`applied and verified: ${currentPlan.slug} version ${version}`);
  } finally {
    await modules.closePool();
  }
}

try {
  if (["--help", "-h", "help", ""].includes(command)) usage();
  if (command === "public-export") await publicExport();
  else if (command === "db-actors") await dbActors();
  else if (command === "db-export") await dbExport();
  else if (command === "db-apply") await dbApply();
  else usage(`不明なコマンドです: ${command}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
