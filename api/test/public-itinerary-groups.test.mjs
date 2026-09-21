import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const sourceUrl = new URL("../src/public-itinerary-groups.ts", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
const { anonymizePublicItineraryGroups } = await import(moduleUrl);

test("公開行程は実IDを消しつつ同じ日の班構成を維持する", () => {
  const rows = [
    { plan_id: "public", item_date: "2026-09-25", member_ids: null },
    { plan_id: "public", item_date: "2026-09-25", member_ids: '["usr-a","usr-b"]' },
    { plan_id: "public", item_date: "2026-09-25", member_ids: '["usr-b","usr-a"]' },
    { plan_id: "private", item_date: "2026-09-25", member_ids: '["usr-secret"]' },
  ];
  const periods = ["usr-a", "usr-b", "usr-c"].map((user_id) => ({
    plan_id: "public", user_id, from_date: null, to_date: null,
  }));

  anonymizePublicItineraryGroups(rows, new Set(["public"]), periods);

  assert.equal(rows[0].member_ids, null);
  assert.equal(rows[0].public_track_key, null);
  assert.deepEqual(rows[0].public_day_track_keys, ["public-group-1", "public-group-2"]);
  assert.equal(rows[1].public_track_key, "public-group-1");
  assert.equal(rows[2].public_track_key, rows[1].public_track_key);
  assert.equal(rows[3].member_ids, '["usr-secret"]');
  assert.equal(JSON.stringify(rows.slice(0, 3)).includes("usr-"), false);
  assert.equal(JSON.stringify(rows.slice(0, 3)).includes("anon-"), false);
});

test("参加期間外の人は全員予定の匿名集合へ含めない", () => {
  const rows = [{ plan_id: "p", item_date: "2026-09-27", member_ids: null }];
  const periods = [
    { plan_id: "p", user_id: "active", from_date: "2026-09-26", to_date: "2026-09-28" },
    { plan_id: "p", user_id: "left", from_date: null, to_date: "2026-09-26" },
  ];
  anonymizePublicItineraryGroups(rows, new Set(["p"]), periods);
  assert.equal(rows[0].public_track_key, null);
  assert.equal(rows[0].public_day_track_keys, null);
});
