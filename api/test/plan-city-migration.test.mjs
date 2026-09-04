import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("plan_citiesは滞在期間と座標を保存・取得する", () => {
  const schema = read("schema/002_relational.sql");
  const migration = read("scripts/migrate.mjs");
  const repo = read("src/plan-repo.ts");
  const bootstrap = read("src/bootstrap-repo.ts");
  assert.match(schema, /CREATE TABLE plan_cities[\s\S]*from_date[\s\S]*to_date[\s\S]*lat[\s\S]*lng/);
  assert.match(migration, /013_plan_city_details/);
  assert.match(migration, /MIN\(item_date\).*MAX\(item_date\)/s);
  assert.match(repo, /INSERT INTO plan_cities \(id, plan_id, name, from_date, to_date, lat, lng, sort_order\)/);
  assert.match(bootstrap, /SELECT id, plan_id, name, from_date, to_date, lat, lng, sort_order FROM plan_cities/);
});
