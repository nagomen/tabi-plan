import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const {
  daysBetween, finalizeItineraryDraft, finalizeItineraryOptions, MAX_AI_CITIES, validateRegisteredCities,
} = await import("../dist/ai-itinerary.js");

const emptyItem = (overrides = {}) => ({
  kind: "sight",
  time: "10:00",
  city: "ニューヨーク",
  title: "観光",
  place: "ニューヨーク",
  note: "",
  from_place: "",
  to_place: "",
  transport: "",
  duration_minutes: 0,
  ...overrides,
});

test("同日複数都市では観光と都市間移動を現在地と時刻の順に交互配置する", () => {
  const draft = finalizeItineraryDraft({
    cities: [
      { name: "深圳", from_date: "2026-10-13", to_date: "2026-10-13" },
      { name: "廈門", from_date: "2026-10-13", to_date: "2026-10-13" },
      { name: "金門島", from_date: "2026-10-13", to_date: "2026-10-13" },
    ],
    days: [{
      date: "2026-10-13", area: "深圳", items: [
        emptyItem({ city: "金門島", time: "17:00", title: "金門島観光", place: "莒光楼" }),
        emptyItem({ city: "深圳", time: "08:00", title: "深圳観光", place: "深圳博物館" }),
        emptyItem({ city: "廈門", time: "13:00", title: "廈門観光", place: "鼓浪嶼" }),
      ],
    }],
    transitions: [
      {
        date: "2026-10-13", time: "15:30", from_city: "廈門", to_city: "金門島",
        from_place: "五通客運碼頭", to_place: "水頭碼頭", transport: "フェリー",
        duration_minutes: 30, note: "海路が合理的",
      },
      {
        date: "2026-10-13", time: "10:00", from_city: "深圳", to_city: "廈門",
        from_place: "深圳北駅", to_place: "厦門北駅", transport: "電車",
        duration_minutes: 120, note: "鉄道が合理的",
      },
    ],
    omitted_selected_places: [],
  }, ["2026-10-13"]);

  assert.deepEqual(draft.days[0].items.map((item) => item.title), [
    "深圳観光", "深圳 → 廈門", "廈門観光", "廈門 → 金門島", "金門島観光",
  ]);
  assert.equal(draft.days[0].area, "深圳");
});

test("都市を出発した後に同じ都市へ戻る予定を拒否する", () => {
  assert.throws(() => finalizeItineraryDraft({
    cities: [
      { name: "深圳", from_date: "2026-10-13", to_date: "2026-10-13" },
      { name: "廈門", from_date: "2026-10-13", to_date: "2026-10-13" },
    ],
    days: [{ date: "2026-10-13", area: "深圳", items: [
      emptyItem({ city: "深圳", time: "14:00", title: "深圳観光", place: "大芬油画村" }),
    ] }],
    transitions: [{
      date: "2026-10-13", time: "10:00", from_city: "深圳", to_city: "廈門",
      from_place: "深圳北駅", to_place: "厦門北駅", transport: "電車",
      duration_minutes: 120, note: "鉄道が合理的",
    }],
    omitted_selected_places: [],
  }, ["2026-10-13"]), /廈門滞在中.*深圳/);
});

test("到着見込み時刻より前に到着都市の予定を置いた結果を拒否する", () => {
  assert.throws(() => finalizeItineraryDraft({
    cities: [
      { name: "深圳", from_date: "2026-10-13", to_date: "2026-10-13" },
      { name: "廈門", from_date: "2026-10-13", to_date: "2026-10-13" },
    ],
    days: [{ date: "2026-10-13", area: "深圳", items: [
      emptyItem({ city: "廈門", time: "11:00", title: "廈門観光", place: "鼓浪嶼" }),
    ] }],
    transitions: [{
      date: "2026-10-13", time: "10:00", from_city: "深圳", to_city: "廈門",
      from_place: "深圳北駅", to_place: "厦門北駅", transport: "電車",
      duration_minutes: 120, note: "鉄道が合理的",
    }],
    omitted_selected_places: [],
  }, ["2026-10-13"]), /到着前/);
});

test("順不同・行政区分付きの必要区間だけを正しい到着日の行程へ挿入する", () => {
  const draft = finalizeItineraryDraft({
    cities: [
      { name: "ニューヨーク", from_date: "2026-08-19", to_date: "2026-08-21" },
      { name: "シカゴ", from_date: "2026-08-21", to_date: "2026-08-23" },
      { name: "エバンストン", from_date: "2026-08-23", to_date: "2026-08-25" },
    ],
    days: [
      { date: "2026-08-19", area: "ニューヨーク", items: [emptyItem()] },
      { date: "2026-08-21", area: "シカゴ", items: [emptyItem({
        kind: "move", title: "ニューヨーク → シカゴ", transport: "その他",
      })] },
      { date: "2026-08-23", area: "エバンストン", items: [] },
    ],
    transitions: [
      {
        date: "2026-08-23", time: "18:00", from_city: "エバンストン", to_city: "ニューヨーク",
        from_place: "Davis Street駅", to_place: "ニューヨーク市内",
        transport: "電車", duration_minutes: 60, note: "登録ルートにはない余剰区間",
      },
      {
        date: "2026-08-23", time: "10:00", from_city: "シカゴ市", to_city: "エバンストン市",
        from_place: "Ogilvie Transportation Center", to_place: "Davis Street駅",
        transport: "電車", duration_minutes: 35, note: "近距離で公共交通が利用しやすい",
      },
      {
        date: "2026-08-21", time: "09:00", from_city: "ニューヨーク市", to_city: "シカゴ市",
        from_place: "ジョン・F・ケネディ国際空港", to_place: "シカゴ・オヘア国際空港",
        transport: "飛行機", duration_minutes: 165, note: "長距離のため所要時間を抑えられる",
      },
    ],
  }, ["2026-08-19", "2026-08-21", "2026-08-23"]);

  const chicagoMove = draft.days[1].items[0];
  assert.equal(chicagoMove.title, "ニューヨーク → シカゴ");
  assert.equal(chicagoMove.transport, "飛行機");
  assert.equal(chicagoMove.duration_minutes, 165);
  assert.equal(draft.days[1].items.filter((item) => item.kind === "move").length, 1);
  assert.equal(draft.days[2].items[0].transport, "電車");
  assert.equal(draft.days.flatMap((day) => day.items).some((item) => item.title === "エバンストン → ニューヨーク"), false);
});

test("都市数に対して移動区間が不足した結果を拒否する", () => {
  assert.throws(() => finalizeItineraryDraft({
    cities: [
      { name: "東京", from_date: "2026-10-01", to_date: "2026-10-01" },
      { name: "京都", from_date: "2026-10-02", to_date: "2026-10-02" },
    ],
    days: [
      { date: "2026-10-01", area: "東京", items: [] },
      { date: "2026-10-02", area: "京都", items: [] },
    ],
    transitions: [],
  }, ["2026-10-01", "2026-10-02"]), /都市間移動が不足/);
});

test("相談用の観光候補は重複を除き、有限個の選択肢として返す", () => {
  const options = finalizeItineraryOptions({
    message: "候補から選んでください。",
    candidates: [
      { name: "中尊寺", area: "平泉", category: "文化", reason: "歴史を感じられる", duration_minutes: 120 },
      { name: "中尊寺", area: "平泉", category: "文化", reason: "重複", duration_minutes: 90 },
      { name: "毛越寺", area: "平泉", category: "文化", reason: "庭園を楽しめる", duration_minutes: 90 },
      { name: "猊鼻渓", area: "一関", category: "自然", reason: "渓谷の景観", duration_minutes: 150 },
    ],
  });
  assert.deepEqual(options.candidates.map((candidate) => candidate.id), ["ai-place-1", "ai-place-2", "ai-place-3"]);
  assert.deepEqual(options.candidates.map((candidate) => candidate.name), ["中尊寺", "毛越寺", "猊鼻渓"]);
});

test("相談用の観光候補を登録都市ごとに返す", () => {
  const options = finalizeItineraryOptions({
    message: "都市ごとに候補を選んでください。",
    candidates: [
      { name: "浅草寺", area: "東京", category: "文化", reason: "江戸文化に触れられる", duration_minutes: 90 },
      { name: "清水寺", area: "京都", category: "文化", reason: "歴史ある景観", duration_minutes: 120 },
      { name: "東京スカイツリー", area: "東京", category: "景観", reason: "市街を一望できる", duration_minutes: 120 },
      { name: "伏見稲荷大社", area: "京都", category: "文化", reason: "千本鳥居を歩ける", duration_minutes: 120 },
    ],
  }, ["東京", "京都"]);

  assert.deepEqual(options.candidates.map((candidate) => candidate.area), ["東京", "京都", "東京", "京都"]);
});

test("登録都市の候補が不足したAI応答を拒否する", () => {
  assert.throws(() => finalizeItineraryOptions({
    message: "候補です。",
    candidates: [
      { name: "浅草寺", area: "東京", category: "文化", reason: "江戸文化に触れられる", duration_minutes: 90 },
      { name: "東京スカイツリー", area: "東京", category: "景観", reason: "市街を一望できる", duration_minutes: 120 },
      { name: "上野公園", area: "東京", category: "自然", reason: "散策しやすい", duration_minutes: 90 },
    ],
  }, ["東京", "京都"]), /京都/);
});

test("1都市の候補は契約どおり2件でも受理する", () => {
  const options = finalizeItineraryOptions({
    message: "候補です。",
    candidates: [
      { name: "浅草寺", area: "東京", category: "文化", reason: "文化", duration_minutes: 90 },
      { name: "上野公園", area: "東京", category: "自然", reason: "散策", duration_minutes: 90 },
    ],
  }, ["東京"]);
  assert.equal(options.candidates.length, 2);
});

test("AI上限を超える都市数と14日超の日程を明示的に拒否する", () => {
  assert.throws(() => finalizeItineraryOptions({ message: "候補", candidates: [] },
    Array.from({ length: MAX_AI_CITIES + 1 }, (_, index) => `都市${index}`)), /最大18都市/);
  assert.throws(() => daysBetween("2026-08-01", "2026-08-15"), /最大14日間/);
});

test("登録都市の重複と旅行期間外の日付を拒否する", () => {
  const dates = daysBetween("2026-08-01", "2026-08-03");
  assert.throws(() => validateRegisteredCities([
    { name: "東京", from_date: "2026-08-01", to_date: "2026-08-01" },
    { name: " 東京 ", from_date: "2026-08-02", to_date: "2026-08-02" },
  ], dates), /重複/);
  assert.throws(() => validateRegisteredCities([
    { name: "京都", from_date: "2026-08-03", to_date: "2026-08-04" },
  ], dates), /旅行期間内/);
});

test("日別行程の欠落と重複を拒否して既存行程へ適用させない", () => {
  assert.throws(() => finalizeItineraryDraft({
    cities: [{ name: "東京", from_date: "2026-08-01", to_date: "2026-08-02" }],
    days: [{ date: "2026-08-01", area: "東京", items: [emptyItem({ city: "東京", place: "浅草寺" })] }],
    transitions: [],
    omitted_selected_places: [],
  }, ["2026-08-01", "2026-08-02"]), /欠落または重複/);
});

test("都市間移動の始終点が登録ルートと違う結果を拒否する", () => {
  assert.throws(() => finalizeItineraryDraft({
    cities: [
      { name: "東京", from_date: "2026-08-01", to_date: "2026-08-01" },
      { name: "京都", from_date: "2026-08-02", to_date: "2026-08-02" },
    ],
    days: [
      { date: "2026-08-01", area: "東京", items: [] },
      { date: "2026-08-02", area: "京都", items: [] },
    ],
    transitions: [{
      date: "2026-08-02", time: "09:00", from_city: "大阪", to_city: "京都",
      from_place: "東京駅", to_place: "京都駅", transport: "新幹線", duration_minutes: 130, note: "合理的",
    }],
    omitted_selected_places: [],
  }, ["2026-08-01", "2026-08-02"]), /移動順が一致しません/);
});

test("選択候補は翻訳後の名称ではなく署名済みIDで採用・未採用を照合する", () => {
  const draft = finalizeItineraryDraft({
    cities: [{ name: "香港", from_date: "2026-08-01", to_date: "2026-08-01" }],
    days: [{ date: "2026-08-01", area: "香港", items: [emptyItem({
      city: "香港",
      title: "ビクトリア・ピーク観光",
      place: "山頂広場",
      selected_candidate_ids: ["ai-place-1"],
    })] }],
    transitions: [],
    omitted_selected_candidate_ids: ["ai-place-2"],
  }, ["2026-08-01"], [
    { id: "ai-place-1", name: "The Peak / Peak Tram", area: "香港" },
    { id: "ai-place-2", name: "海辺のローカル海鮮・夜市", area: "香港" },
  ]);

  assert.deepEqual(draft.omitted_selected_places, ["海辺のローカル海鮮・夜市"]);
  assert.equal("selected_candidate_ids" in draft.days[0].items[0], false);
});

test("選択候補IDの欠落・重複・未知IDを拒否する", () => {
  const selected = [
    { id: "ai-place-1", name: "The Peak / Peak Tram", area: "香港" },
    { id: "ai-place-2", name: "Gulangyu（鼓浪嶼）", area: "香港" },
  ];
  const raw = (ids, omitted = []) => ({
    cities: [{ name: "香港", from_date: "2026-08-01", to_date: "2026-08-01" }],
    days: [{ date: "2026-08-01", area: "香港", items: [emptyItem({
      city: "香港", selected_candidate_ids: ids,
    })] }],
    transitions: [],
    omitted_selected_candidate_ids: omitted,
  });
  assert.throws(() => finalizeItineraryDraft(raw(["ai-place-1"]), ["2026-08-01"], selected), /採用・未採用/);
  assert.throws(() => finalizeItineraryDraft(raw(["ai-place-1"], ["ai-place-1", "ai-place-2"]), ["2026-08-01"], selected), /重複/);
  assert.throws(() => finalizeItineraryDraft(raw(["ai-place-1", "unknown"], ["ai-place-2"]), ["2026-08-01"], selected), /不明な選択候補ID/);
});

test("都市間移動時刻は構造化出力でも空欄を許可しない", () => {
  const source = fs.readFileSync(new URL("../src/ai-itinerary.ts", import.meta.url), "utf8");
  assert.match(source, /transitions:[\s\S]*pattern: "\^\(\?:\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\$"/);
  assert.match(source, /transitions\.time[\s\S]*空文字にはしない/);
});

test("Web検索で確認した住所と座標を地図登録用に保持する", () => {
  const draft = finalizeItineraryDraft({
    cities: [{
      name: "香港", from_date: "2026-08-01", to_date: "2026-08-01",
      address: "Hong Kong", latitude: 22.3193, longitude: 114.1694,
    }],
    days: [{
      date: "2026-08-01", area: "香港", items: [emptyItem({
        city: "香港", title: "中環周辺の散策", place: "Central, Hong Kong",
        address: "Central, Hong Kong", latitude: 22.2819, longitude: 114.1589,
      })],
    }],
    transitions: [],
    omitted_selected_places: [],
  }, ["2026-08-01"]);

  assert.equal(draft.cities[0].latitude, 22.3193);
  assert.equal(draft.days[0].items[0].address, "Central, Hong Kong");
  assert.equal(draft.days[0].items[0].latitude, 22.2819);
  assert.equal(draft.days[0].items[0].longitude, 114.1589);
});

test("片方でも不正な座標は地図へ登録しない", () => {
  const draft = finalizeItineraryDraft({
    cities: [{ name: "香港", from_date: "2026-08-01", to_date: "2026-08-01" }],
    days: [{
      date: "2026-08-01", area: "香港",
      items: [emptyItem({ city: "香港", address: "Central, Hong Kong", latitude: 999, longitude: 114.1589 })],
    }],
    transitions: [],
    omitted_selected_places: [],
  }, ["2026-08-01"]);
  assert.equal(draft.days[0].items[0].latitude, null);
  assert.equal(draft.days[0].items[0].longitude, null);
});
