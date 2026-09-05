import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { finalizeRefinedItinerary } = await import("../dist/ai-itinerary-refine.js");

const item = (overrides = {}) => ({
  time: "09:00", kind: "sight", city: "深圳", title: "深圳観光", place: "大芬油画村",
  address: "深圳市", latitude: null, longitude: null, note: "",
  from_city: "", from_place: "", from_address: "", from_latitude: null, from_longitude: null,
  to_city: "", to_place: "", to_address: "", to_latitude: null, to_longitude: null,
  transport: "", duration_minutes: 0, ...overrides,
});

test("チャット修正案も観光と都市間移動を実行順に保持する", () => {
  const result = finalizeRefinedItinerary({ message: "移動順を直しました。", days: [{
    date: "2026-10-13",
    items: [
      item({ time: "17:00", city: "金門島", title: "金門島観光", place: "莒光楼" }),
      item({ time: "09:00" }),
      item({
        time: "14:30", kind: "move", city: "金門島", title: "廈門 → 金門島", place: "水頭碼頭",
        from_city: "廈門", from_place: "五通客運碼頭", from_address: "廈門市",
        to_city: "金門島", to_place: "水頭碼頭", to_address: "金門県",
        transport: "フェリー", duration_minutes: 30,
      }),
      item({ time: "13:00", city: "廈門", title: "廈門観光", place: "鼓浪嶼" }),
      item({
        time: "10:00", kind: "move", city: "廈門", title: "深圳 → 廈門", place: "廈門北駅",
        from_city: "深圳", from_place: "深圳北駅", from_address: "深圳市",
        to_city: "廈門", to_place: "廈門北駅", to_address: "廈門市",
        transport: "電車", duration_minutes: 120,
      }),
    ],
  }] }, ["2026-10-13"]);
  assert.deepEqual(result.itinerary.map((entry) => entry.title), [
    "深圳観光", "深圳 → 廈門", "廈門観光", "廈門 → 金門島", "金門島観光",
  ]);
});

test("移動到着前の予定と旅行日の欠落を拒否する", () => {
  assert.throws(() => finalizeRefinedItinerary({ message: "変更", days: [{
    date: "2026-10-13", items: [
      item({
        time: "10:00", kind: "move", city: "廈門", title: "深圳 → 廈門", place: "廈門北駅",
        from_city: "深圳", from_place: "深圳北駅", to_city: "廈門", to_place: "廈門北駅",
        transport: "電車", duration_minutes: 120,
      }),
      item({ time: "11:00", city: "廈門", title: "廈門観光" }),
    ],
  }] }, ["2026-10-13"]), /到着前/);
  assert.throws(() => finalizeRefinedItinerary({ message: "変更", days: [
    { date: "2026-10-13", items: [] },
  ] }, ["2026-10-13", "2026-10-14"]), /日付の欠落/);
});

test("チャット修正案は対象メンバーを保持し、知らないIDは保存対象から外す", () => {
  const result = finalizeRefinedItinerary({
    message: "メンバー分岐を保ちました。",
    days: [{
      date: "2026-10-12",
      items: [
        item({ members: ["usr_owner", "unknown", "usr_owner"] }),
        item({
          time: "11:00", kind: "move", city: "香港", title: "帰国組：香港空港方面へ", place: "香港国際空港",
          from_city: "深圳", from_place: "深圳北駅", from_address: "深圳市",
          to_city: "香港", to_place: "香港国際空港", to_address: "香港",
          transport: "電車", duration_minutes: 120,
          members: ["usr_returning"],
        }),
      ],
    }],
  }, ["2026-10-12"], {
    members: [
      { user_id: "usr_owner", name: "小宮", from_date: "2026-10-09", to_date: "2026-10-18" },
      { user_id: "usr_returning", name: "帰国組", from_date: "2026-10-09", to_date: "2026-10-12" },
    ],
  });

  assert.deepEqual(result.itinerary[0].members, ["usr_owner"]);
  assert.deepEqual(result.itinerary[1].members, ["usr_returning"]);
});

test("チャット修正案は参加期間外メンバーを保存対象から外す", () => {
  const result = finalizeRefinedItinerary({
    message: "参加期間に合わせて分岐を整理しました。",
    days: [{
      date: "2026-10-13",
      items: [
        item({ members: ["usr_owner", "usr_returning"] }),
      ],
    }],
  }, ["2026-10-13"], {
    members: [
      { user_id: "usr_owner", name: "小宮", from_date: "2026-10-09", to_date: "2026-10-18" },
      { user_id: "usr_returning", name: "帰国組", from_date: "2026-10-09", to_date: "2026-10-12" },
    ],
  });

  assert.deepEqual(result.itinerary[0].members, ["usr_owner"]);
  assert.throws(() => finalizeRefinedItinerary({
    message: "参加期間に合わせました。",
    days: [{
      date: "2026-10-13",
      items: [item({ members: ["usr_returning"] })],
    }],
  }, ["2026-10-13"], {
    members: [
      { user_id: "usr_returning", name: "帰国組", from_date: "2026-10-09", to_date: "2026-10-12" },
    ],
  }), /参加期間外/);
});
