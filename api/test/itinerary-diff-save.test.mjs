import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { replacePlanContent, validatePlanContent } = await import("../dist/plan-repo.js");

const stored = (id, title, order) => ({
  id,
  item_date: "2026-10-01",
  day_index: 0,
  sort_order: order,
  kind: "sight",
  start_time: "10:00:00",
  title,
  place: null,
  area: "香港",
  note: null,
  map_query: null,
  lat: null,
  lng: null,
  from_place: null,
  from_lat: null,
  from_lng: null,
  to_place: null,
  to_lat: null,
  to_lng: null,
  transport: null,
  duration_minutes: null,
  member_ids: null,
});

const input = (id, title) => ({
  id,
  item_date: "2026-10-01",
  day_index: 0,
  kind: "sight",
  start_time: "10:00:00",
  title,
  area: "香港",
});

test("ブラウザ保存は行程を全削除せず変更・追加・削除だけを反映する", async () => {
  const queries = [];
  const connection = {
    async query(sql, params = []) {
      const text = String(sql);
      queries.push({ text, params });
      if (text.includes("FROM plans WHERE id")) {
        return [[{ version: 8, source: "local", visibility: "invite", status: "draft", open_editing: 0 }], []];
      }
      if (text.includes("FROM plan_access_grants")) return [[{ role: "owner" }], []];
      if (text.includes("FROM itinerary_items WHERE plan_id")) {
        return [[stored("itm_keep", "変更前", 0), stored("itm_delete", "削除", 1)], []];
      }
      if (text.includes("FROM itinerary_items WHERE id IN")) return [[], []];
      return [{ affectedRows: 1 }, []];
    },
  };

  const version = await replacePlanContent("pln_trip", {
    itinerary: [input("itm_keep", "変更後"), input("itm_new", "追加")],
  }, 8, "usr_owner", connection);

  assert.equal(version, 9);
  assert.equal(queries.some(({ text }) => /DELETE FROM itinerary_items WHERE plan_id/.test(text)), false);
  assert.equal(queries.filter(({ text }) => /UPDATE itinerary_items SET item_date/.test(text)).length, 1);
  assert.equal(queries.filter(({ text }) => /INSERT INTO itinerary_items/.test(text)).length, 1);
  assert.equal(queries.filter(({ text }) => /DELETE FROM itinerary_items WHERE id/.test(text)).length, 1);
  assert.equal(queries.filter(({ text }) => /INSERT INTO itinerary_audit_logs/.test(text)).length, 3);
});

test("行程IDは形式と重複を検査する", async () => {
  assert.throws(
    () => validatePlanContent({ itinerary: [input("invalid id", "予定")] }),
    /行程1件目のID/,
  );
});
