import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

// インライン編集は画面（dialog/地図）に触るので、保存ロジックだけを取り出して検証する。
function load(relativePath, stubs = {}) {
  const javascript = ts.transpileModule(read(relativePath), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, require: (id) => stubs[id] || {} });
  return module.exports;
}

const {
  applyCityEdit, applyDayAppend, applyDayInsert, applyDayRemove, applyItemEdit, applyPointMove,
  applyReorder, applyTripEdit, itemsOnDate, locate, planDayLabel, shiftDate, tripDatesLabel,
} = load("src/dashboard/inline-store.ts", {
  "../shared/date": load("src/shared/date.ts"),
  "./state": { CONFIG: { tripSlug: "trip", mode: "local" }, hooks: {} },
});

const { normalizeLng } = load("src/dashboard/inline-map-edit.ts", {
  "./inline-editor": {}, "./inline-mode": {}, "./inline-store": {},
});

function samplePlan() {
  return {
    trip: {
      title: "旅行",
      dates: "2027/3/10 - 2027/3/12",
      startDate: "2027-03-10",
      endDate: "2027-03-12",
      members: "参加者A、参加者B",
      note: "共有メモ",
      cover: "./images/cover_hongkong.webp",
    },
    itinerary: [
      { itemId: "a", date: "2027-03-10", day: "Day 1", title: "空港", type: "move", place: "羽田", lat: 35.5, lng: 139.7, mapQuery: "羽田空港" },
      { itemId: "b", date: "2027-03-11", day: "Day 2", title: "市内観光", type: "sight", place: "中環" },
      { itemId: "c", date: "2027-03-12", day: "Day 3", title: "帰国", type: "move", place: "香港国際空港" },
    ],
    cities: [{ name: "香港", fromDate: "2027-03-10", toDate: "2027-03-12" }],
    checklist: [{ label: "保険", done: false }],
  };
}

test("予定を直しても旅行情報（期間・カバー・参加者）は消えない", () => {
  const data = samplePlan();
  applyItemEdit(data, 1, { date: "2027-03-11", title: "点心を食べる", type: "food", place: "添好運" });
  assert.deepEqual(data.trip, samplePlan().trip);
  assert.equal(data.itinerary[1].title, "点心を食べる");
  assert.equal(data.itinerary[1].itemId, "b", "itemId を保って同じ行を更新する");
  assert.equal(data.cities.length, 1);
});

test("既存の予定を直しても座標・mapQuery は引き継ぐ", () => {
  const data = samplePlan();
  applyItemEdit(data, 0, { date: "2027-03-10", title: "羽田空港 出発", type: "move", place: "羽田空港 第3ターミナル" });
  assert.equal(data.itinerary[0].lat, 35.5);
  assert.equal(data.itinerary[0].lng, 139.7);
  assert.equal(data.itinerary[0].mapQuery, "羽田空港", "地図の検索語は勝手に書き換えない");
});

test("場所検索で選んだ座標は予定に入る", () => {
  const data = samplePlan();
  applyItemEdit(data, 1, { date: "2027-03-11", title: "市内観光", type: "sight", place: "中環", lat: 22.2819, lng: 114.1583 });
  assert.equal(data.itinerary[1].lat, 22.2819);
  assert.equal(data.itinerary[1].lng, 114.1583);
});

test("予定の追加は末尾に足し、Day ラベルを開始日から決める", () => {
  const data = samplePlan();
  applyItemEdit(data, -1, { date: "2027-03-12", title: "お土産", type: "sight", place: "空港免税店" });
  assert.equal(data.itinerary.length, 4);
  assert.equal(data.itinerary[3].day, "Day 3");
  assert.equal(data.itinerary[3].mapQuery, "空港免税店", "新しい予定は場所を地図の検索語にする");
});

test("日付を別の日へ移すと Day ラベルも付け替わる", () => {
  const data = samplePlan();
  applyItemEdit(data, 1, { date: "2027-03-12", title: "市内観光", type: "sight" });
  assert.equal(data.itinerary[1].day, "Day 3");
});

test("開始日が未設定の計画は予定の最初の日を 1 日目と見なす", () => {
  const data = samplePlan();
  data.trip.startDate = "";
  assert.equal(planDayLabel(data, "2027-03-11"), "Day 2");
  assert.equal(planDayLabel(data, "2027-03-09"), undefined, "旅程より前の日はラベルを付けない");
});

test("旅行情報の保存はメモと参加者を残し、期間ラベルを作り直す", () => {
  const data = samplePlan();
  applyTripEdit(data, { title: "香港旅行", start: "2027-03-10", end: "2027-03-13", cover: "" });
  assert.equal(data.trip.title, "香港旅行");
  assert.equal(data.trip.dates, "2027/3/10 - 2027/3/13");
  assert.equal(data.trip.endDate, "2027-03-13");
  assert.equal(data.trip.cover, "");
  assert.equal(data.trip.note, "共有メモ");
  assert.equal(data.trip.members, "参加者A、参加者B");
  assert.equal(tripDatesLabel("2027-03-10", "2027-03-10"), "2027/3/10", "同じ日なら 1 日分のラベル");
});

test("ドラッグの並べ替えは、その日の予定が使っている位置だけを入れ替える", () => {
  const data = samplePlan();
  data.itinerary.splice(2, 0, { itemId: "d", date: "2027-03-11", day: "Day 2", title: "夕食", type: "food" });
  // 2日目の「市内観光（位置1）」と「夕食（位置2）」を入れ替える。
  assert.equal(applyReorder(data, [{ itemId: "d", index: 2 }, { itemId: "b", index: 1 }]), true);
  assert.deepEqual(data.itinerary.map((item) => item.itemId), ["a", "d", "b", "c"], "他の日の予定は動かさない");
});

test("並べ替えの対象が見つからないときは何もしない", () => {
  const data = samplePlan();
  assert.equal(applyReorder(data, [{ itemId: "missing", index: 99 }]), false);
  assert.equal(applyReorder(data, [{ itemId: "a", index: 0 }, { itemId: "a", index: 0 }]), false, "同じ行を二重に数えない");
  assert.deepEqual(data.itinerary.map((item) => item.itemId), ["a", "b", "c"]);
});

test("保存先の行は itemId で探し、並びが変わっていても取り違えない", () => {
  const data = samplePlan();
  data.itinerary.unshift({ itemId: "z", date: "2027-03-10", title: "別端末で足された予定", type: "todo" });
  assert.equal(locate(data, "b", 1), 2);
  assert.equal(locate(data, "", 1), 1, "itemId が無ければ画面の位置を使う");
  assert.equal(locate(data, "missing", 99), -1);
});

// ---- 日程（日の追加・削除）---------------------------------------------

test("日を足すと期間が1日伸びる", () => {
  const data = samplePlan();
  applyDayAppend(data);
  assert.equal(data.trip.endDate, "2027-03-13");
  assert.equal(data.trip.dates, "2027/3/10 - 2027/3/13");
  assert.deepEqual(data.itinerary.map((item) => item.date), ["2027-03-10", "2027-03-11", "2027-03-12"], "予定は動かさない");
});

test("途中に日を差し込むと、以降の予定・都市が1日ずつ後ろへずれる", () => {
  const data = samplePlan();
  applyDayInsert(data, "2027-03-10");
  assert.deepEqual(data.itinerary.map((item) => item.date), ["2027-03-10", "2027-03-12", "2027-03-13"]);
  assert.deepEqual(data.itinerary.map((item) => item.day), ["Day 1", "Day 3", "Day 4"], "Day 番号を付け直す");
  assert.equal(data.trip.endDate, "2027-03-13");
  assert.equal(data.cities[0].toDate, "2027-03-13", "都市の滞在期間も伸びる");
});

test("日を消すと、その日の予定が消えて以降が1日前へ詰まる", () => {
  const data = samplePlan();
  applyDayRemove(data, "2027-03-11");
  assert.deepEqual(data.itinerary.map((item) => item.itemId), ["a", "c"]);
  assert.deepEqual(data.itinerary.map((item) => item.date), ["2027-03-10", "2027-03-11"]);
  assert.deepEqual(data.itinerary.map((item) => item.day), ["Day 1", "Day 2"]);
  assert.equal(data.trip.endDate, "2027-03-11");
  assert.equal(data.cities[0].toDate, "2027-03-11");
});

test("1日だけの旅行では日を消さない", () => {
  const data = samplePlan();
  data.trip.startDate = "2027-03-10";
  data.trip.endDate = "2027-03-10";
  applyDayRemove(data, "2027-03-10");
  assert.equal(data.itinerary.length, 3, "予定も期間もそのまま");
  assert.equal(data.trip.endDate, "2027-03-10");
});

test("消す日の件数は先に数えられる", () => {
  const data = samplePlan();
  assert.equal(itemsOnDate(data, "2027-03-11").length, 1);
  assert.equal(itemsOnDate(data, "2027-03-20").length, 0);
  assert.equal(shiftDate("2027-03-31", 1), "2027-04-01", "月をまたいでも正しくずらす");
});

// ---- 都市・地図 ---------------------------------------------------------

test("都市は名前と正しい期間が揃った行だけ保存する", () => {
  const data = samplePlan();
  applyCityEdit(data, [
    { name: "香港", fromDate: "2027-03-10", toDate: "2027-03-11" },
    { name: " マカオ ", fromDate: "2027-03-11", toDate: "2027-03-12" },
    { name: "", fromDate: "2027-03-12", toDate: "2027-03-12" },
    { name: "逆さま", fromDate: "2027-03-12", toDate: "2027-03-10" },
  ]);
  assert.deepEqual(data.cities.map((city) => city.name), ["香港", "マカオ"]);
});

test("地図で動かした地点は、掴んだ役割に応じた座標へ書き戻す", () => {
  const data = samplePlan();
  assert.equal(applyPointMove(data, "b", "stay", 22.3, 114.17), true);
  assert.equal(data.itinerary[1].lat, 22.3);
  assert.equal(data.itinerary[1].lng, 114.17);
  applyPointMove(data, "a", "origin", 35.55, 139.78);
  assert.equal(data.itinerary[0].originLat, 35.55);
  assert.equal(data.itinerary[0].lat, 35.5, "出発地を動かしても場所の座標は変えない");
  applyPointMove(data, "a", "destination", 22.31, 113.91);
  assert.equal(data.itinerary[0].destinationLng, 113.91);
  assert.equal(applyPointMove(data, "missing", "stay", 0, 0), false);
});

test("太平洋中心表示でずらした経度は、保存前に元へ戻す", () => {
  assert.ok(Math.abs(normalizeLng(474.1) - 114.1) < 1e-9, "+360 された経度を戻す");
  assert.equal(normalizeLng(139.7), 139.7);
  assert.equal(normalizeLng(-157.8), -157.8);
});

// ---- 画面のつなぎ -------------------------------------------------------

test("保存は表示用データではなく計画本体（ストア）を書き戻す", () => {
  const source = read("src/dashboard/inline-store.ts");
  // TripData は期間・カバー・参加者IDを持たないので、そのまま保存すると消える。
  assert.match(source, /TripPlans\.getData\(CONFIG\.tripSlug\)/);
  assert.match(source, /TripPlans\.saveLocalPlan\(CONFIG\.tripSlug, data, meta\.memberIds\)/);
  assert.doesNotMatch(source, /save(Data|LocalPlan)\([^)]*state\.data/);
  assert.match(source, /db\.flushMutations/);
});

test("観覧画面を離れずに編集モードへ切り替える", () => {
  const main = read("src/dashboard/main.ts");
  const mode = read("src/dashboard/inline-mode.ts");
  const editor = read("src/dashboard/inline-editor.ts");
  const html = read("index.html");
  assert.match(main, /setupInlineEditor\(editHead\)/);
  assert.doesNotMatch(main, /plan-editor\.html/);
  assert.match(html, /data-inline-editbar/);
  assert.match(mode, /root\.classList\.toggle\("is-inline-editing"/);
  assert.match(editor, /location\.hash === "#edit"/);
});

test("予定の追加・編集・削除は同じカード画面から操作する", () => {
  const editor = read("src/dashboard/inline-editor.ts");
  const feed = read("src/dashboard/itinerary-feed.ts");
  assert.match(feed, /data-inline-item-index/);
  assert.match(feed, /data-inline-add-date/);
  assert.match(feed, /data-inline-item-edit/);
  assert.match(editor, /itinerary\.splice\(target, 1\)/);
});

test("日程・都市も観覧画面のダイアログから変える", () => {
  const feed = read("src/dashboard/itinerary-feed.ts");
  const html = read("index.html");
  assert.match(feed, /data-inline-day-insert/);
  assert.match(feed, /data-inline-day-remove/);
  assert.match(html, /data-inline-city-edit/);
  assert.match(html, /data-inline-day-append/);
});

test("並べ替えの sortablejs は編集モードに入ってから読み込む", () => {
  const editor = read("src/dashboard/inline-editor.ts");
  const feed = read("src/dashboard/itinerary-feed.ts");
  assert.match(editor, /await import\("sortablejs"\)/);
  assert.doesNotMatch(editor, /^import Sortable/m);
  assert.match(editor, /handle: "\.tl-inline-grip"/);
  assert.match(feed, /tl-inline-grip/);
});

test("地図のピンは編集モードのときだけ掴んで動かせる", () => {
  const map = read("src/dashboard/leaflet-map.ts");
  const dashboardMap = read("src/dashboard/map.ts");
  assert.match(map, /draggable: editable/);
  assert.match(map, /marker\.on\("dragend"/);
  assert.match(map, /data-map-edit/);
  assert.match(dashboardMap, /mapEditHooks\(\)/);
});

test("既存計画の編集導線は観覧画面の編集モードへ入る", () => {
  for (const path of ["src/plans/main.ts", "src/mypage/plans-list.ts", "src/plans/plan-actions.ts", "src/dashboard/plan-copy.ts"]) {
    const source = read(path);
    assert.match(source, /index\.html\?plan=/);
    assert.match(source, /#edit/);
  }
});

test("計画エディタは新規作成のウィザードだけを受け持つ", () => {
  const handoff = read("src/plan-editor/editing-handoff.ts");
  const main = read("src/plan-editor/main.ts");
  const persist = read("src/plan-editor/persist.ts");
  assert.match(handoff, /location\.replace\(`index\.html\?plan=\$\{encodeURIComponent\(slug\)\}#edit`\)/);
  assert.match(main, /handOffExistingPlanToDashboard\(\)/);
  assert.match(main, /if \(!handedOff\) \{/);
  // ウィザードが作った下書きは、同じタブで開き直しても観覧画面へ飛ばさない。
  assert.match(persist, /markEditorDraft\(state\.slug\)/);
});
