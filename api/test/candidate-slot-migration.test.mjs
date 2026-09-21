import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("候補の時間枠・対象メンバー・場所をDB往復できる", () => {
  const schema = read("schema/002_relational.sql");
  const migration = read("scripts/migrate.mjs");
  const repo = read("src/plan-repo.ts");
  const bootstrap = read("src/bootstrap-repo.ts");
  assert.match(schema, /CREATE TABLE plan_candidates[\s\S]*slot_id[\s\S]*item_date[\s\S]*member_ids/);
  assert.match(migration, /017_candidate_time_slots/);
  assert.match(repo, /INSERT INTO plan_candidates[\s\S]*slot_id[\s\S]*member_ids/);
  assert.match(bootstrap, /slot_id, item_date, start_time, kind, duration_minutes, lat, lng, note, member_ids FROM plan_candidates/);
});
