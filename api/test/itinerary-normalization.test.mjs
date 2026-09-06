import test from "node:test";
import assert from "node:assert/strict";

const {
  assertDistinctStartTimes, assertStaysInFinalCity, cityNamesEquivalent, strictTimeMinutes, walkDaySchedule,
} = await import("../dist/itinerary-normalization.js");

test("初回生成とチャット修正が共有する1日の行程検証", () => {
  assert.throws(() => assertDistinctStartTimes("2026-10-13", [
    { minutes: 600, label: "a" }, { minutes: 600, label: "b" },
  ]), /同じ開始時刻/);

  assert.throws(() => walkDaySchedule("2026-10-13", [
    { minutes: 600, label: "深圳 → 廈門", move: { fromCity: "深圳", toCity: "廈門", durationMinutes: 120 } },
    { minutes: 660, label: "廈門観光", city: "廈門" },
  ]), /到着前/);

  assert.throws(() => walkDaySchedule("2026-10-13", [
    { minutes: 600, label: "廈門 → 金門島", move: { fromCity: "廈門", toCity: "金門島", durationMinutes: 30 } },
  ], "深圳"), /現在地深圳から始まっていません/);

  assert.throws(() => walkDaySchedule("2026-10-13", [
    { minutes: 600, label: "廈門観光", city: "廈門" },
  ], "深圳"), /深圳滞在中の時刻ですが、廈門の予定/);

  // 正常系: 観光 → 移動 → 到着都市の観光。都市名の行政区分差は同一視する。
  const finalCity = walkDaySchedule("2026-10-13", [
    { minutes: 540, label: "深圳観光", city: "深圳" },
    { minutes: 600, label: "深圳 → 廈門", move: { fromCity: "深圳", toCity: "廈門", durationMinutes: 120 } },
    { minutes: 780, label: "廈門観光", city: "廈門市" },
  ]);
  assert.equal(finalCity, "廈門");

  // onCommit で呼び出し側の追加検証（訪問順など）を差し込める。
  let committed = 0;
  walkDaySchedule("2026-10-13", [
    { minutes: 600, label: "移動", move: { fromCity: "深圳", toCity: "廈門", durationMinutes: 30, onCommit: () => { committed += 1; } } },
  ]);
  assert.equal(committed, 1);

  assert.equal(assertStaysInFinalCity("2026-10-13", [{ city: "廈門市" }], "廈門"), "廈門");
  assert.throws(() => assertStaysInFinalCity("2026-10-13", [{ city: "深圳" }], "廈門"), /最終到着都市/);
  // その日に予定が無ければ最初の宿泊都市を最終都市として採用する。
  assert.equal(assertStaysInFinalCity("2026-10-13", [{ city: "東京" }], ""), "東京");
});

test("都市名の同一視と時刻の厳格な解釈", () => {
  assert.equal(cityNamesEquivalent("盛岡", "盛岡市"), true);
  assert.equal(cityNamesEquivalent("Kyoto City", "kyoto"), true);
  assert.equal(cityNamesEquivalent("盛岡", "仙台"), false);
  assert.equal(cityNamesEquivalent("", "盛岡"), false);

  assert.equal(strictTimeMinutes("09:30"), 570);
  assert.equal(strictTimeMinutes("23:59"), 1439);
  assert.equal(strictTimeMinutes("24:00"), null);
  assert.equal(strictTimeMinutes(""), null);
});
