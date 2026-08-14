#!/usr/bin/env node
// data/ の JSON を共有ストア API へ一度だけ流し込む（localStorage/git 配布 → DB の移行）。
//
// 共有ストア API を有効にすると、フロントは git の「種」を当てなくなる
// （毎回サーバーを古いコミット内容で上書きしてしまうため）。
// そのぶん、最初の中身はこのスクリプトで入れる。
//
// 使い方:
//   API_BASE=http://127.0.0.1:8001 LEGACY_STORE_TOKEN=xxxx node api/scripts/seed-from-data.mjs
//   --force を付けると、サーバー側に既にあるキーも上書きする。
//
// 端末固有のキー（trip-dashboard-user）は配らない。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const API_BASE = (process.env.API_BASE || "http://127.0.0.1:8001").replace(/\/+$/, "");
const LEGACY_STORE_TOKEN = process.env.LEGACY_STORE_TOKEN || "";
const FORCE = process.argv.includes("--force");

const DEVICE_LOCAL = new Set(["trip-dashboard-user"]);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.warn(`  読み飛ばし: ${path.basename(file)} (${error.message})`);
    return undefined;
  }
}

/** data/plans/<slug>.json → 一覧メタ + 本体データ に展開する。 */
function collectPlans() {
  const dir = path.join(repoRoot, "data", "plans");
  if (!fs.existsSync(dir)) return { metas: [], entries: [] };
  const metas = [];
  const entries = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const plan = readJson(path.join(dir, file));
    if (!plan || !plan.slug) continue;
    const { data, ...meta } = plan;
    metas.push({ ...meta, source: "local" });
    if (data) entries.push([`trip-dashboard-plan-${plan.slug}`, data]);
  }
  return { metas, entries };
}

function collectStore() {
  const dir = path.join(repoRoot, "data", "store");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f.replace(/\.json$/, ""), readJson(path.join(dir, f))])
    .filter(([key, value]) => value !== undefined && !DEVICE_LOCAL.has(key));
}

async function api(pathname, init = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LEGACY_STORE_TOKEN}`, ...(init.headers || {}) },
  });
  return res;
}

async function main() {
  if (!LEGACY_STORE_TOKEN) throw new Error("LEGACY_STORE_TOKEN が未設定です");

  const health = await api("/api/health");
  if (!health.ok) throw new Error(`API に到達できません: HTTP ${health.status}`);

  const dumpRes = await api("/api/store");
  if (!dumpRes.ok) throw new Error(`dump 失敗: HTTP ${dumpRes.status}`);
  const { store: existing } = await dumpRes.json();

  const { metas, entries } = collectPlans();
  const payload = [...entries, ...collectStore()];
  if (metas.length) payload.push(["trip-dashboard-plans", metas]);

  let sent = 0;
  let skipped = 0;
  for (const [key, value] of payload) {
    if (!FORCE && Object.prototype.hasOwnProperty.call(existing, key)) {
      skipped += 1;
      continue;
    }
    const res = await api(`/api/store/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
    if (!res.ok) {
      console.error(`  失敗 ${key}: HTTP ${res.status}`);
      continue;
    }
    sent += 1;
  }
  console.log(`投入 ${sent}件 / 既存のためスキップ ${skipped}件 / 対象 ${payload.length}件`);
  console.log(`計画 ${metas.length}件、ストア ${collectStore().length}件`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
