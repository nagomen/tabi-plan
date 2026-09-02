import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function load(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports });
  return module.exports;
}

const { isMemberPresentOn, presentMemberIds, joinersOn, leaversOn } = load("src/shared/member-period.ts");

test("null endpoints mean the member is present for the whole trip", () => {
  const full = { from_date: null, to_date: null };
  assert.equal(isMemberPresentOn(full, "2026-08-01"), true);
  assert.equal(isMemberPresentOn(full, "2026-08-05"), true);
  assert.equal(isMemberPresentOn(full, ""), true);
});

test("a late joiner is absent before from_date and present on/after it", () => {
  const joinsAug3 = { from_date: "2026-08-03", to_date: null };
  assert.equal(isMemberPresentOn(joinsAug3, "2026-08-02"), false);
  assert.equal(isMemberPresentOn(joinsAug3, "2026-08-03"), true);
  assert.equal(isMemberPresentOn(joinsAug3, "2026-08-09"), true);
});

test("an early leaver is present up to and including to_date, absent after", () => {
  const leavesAug4 = { from_date: null, to_date: "2026-08-04" };
  assert.equal(isMemberPresentOn(leavesAug4, "2026-08-04"), true);
  assert.equal(isMemberPresentOn(leavesAug4, "2026-08-05"), false);
});

test("presentMemberIds keeps only members whose window covers the expense date", () => {
  const periods = [
    { user_id: "a", from_date: null, to_date: null },        // 全日程
    { user_id: "b", from_date: "2026-08-03", to_date: null }, // 8/3 合流
    { user_id: "c", from_date: null, to_date: "2026-08-04" }, // 8/4 離脱
  ];
  assert.deepEqual(presentMemberIds(periods, "2026-08-02"), ["a", "c"]);
  assert.deepEqual(presentMemberIds(periods, "2026-08-04"), ["a", "b", "c"]);
  assert.deepEqual(presentMemberIds(periods, "2026-08-05"), ["a", "b"]);
  // 日付未指定なら全員（従来どおり）。
  assert.deepEqual(presentMemberIds(periods, ""), ["a", "b", "c"]);
});

test("joinersOn lists only mid-trip joiners for that exact day", () => {
  const periods = [
    { user_id: "a", from_date: null, to_date: null },          // 全日程
    { user_id: "b", from_date: "2026-08-03", to_date: null },  // 8/3 合流
    { user_id: "c", from_date: "2026-08-01", to_date: null },  // 初日から（合流ではない）
  ];
  // load() は VM 上で実行するため、戻り値の配列は別 realm。spread で比較する。
  assert.deepEqual([...joinersOn(periods, "2026-08-03", "2026-08-01")], ["b"]);
  assert.deepEqual([...joinersOn(periods, "2026-08-02", "2026-08-01")], []);
  // 旅行初日は「合流」と呼ばない（from_date が初日でもバッジは出さない）。
  assert.deepEqual([...joinersOn(periods, "2026-08-01", "2026-08-01")], []);
});

test("leaversOn lists only mid-trip leavers for that exact day", () => {
  const periods = [
    { user_id: "a", from_date: null, to_date: null },
    { user_id: "b", from_date: null, to_date: "2026-08-04" },  // 8/4 まで
    { user_id: "c", from_date: null, to_date: "2026-08-05" },  // 最終日まで（離脱ではない）
  ];
  assert.deepEqual([...leaversOn(periods, "2026-08-04", "2026-08-05")], ["b"]);
  assert.deepEqual([...leaversOn(periods, "2026-08-05", "2026-08-05")], []);
});

test("an equal split over the present members excludes those who were away", () => {
  // computeShares(equal_all) と同じ端数配分を、在籍者だけで再現する。
  const equalSplit = (amount, ids) => {
    const base = Math.floor(amount / ids.length);
    const rest = amount - base * ids.length;
    return ids.map((id, i) => ({ user_id: id, amount_base_minor: base + (i < rest ? 1 : 0) }));
  };
  const periods = [
    { user_id: "a", from_date: null, to_date: null },
    { user_id: "b", from_date: "2026-08-03", to_date: null },
    { user_id: "c", from_date: null, to_date: null },
  ];
  // 8/2 は b が未合流 → a と c だけで 12000 を等分。
  assert.deepEqual(
    equalSplit(12000, presentMemberIds(periods, "2026-08-02")),
    [{ user_id: "a", amount_base_minor: 6000 }, { user_id: "c", amount_base_minor: 6000 }],
  );
  // 8/4 は全員在籍 → 3人で等分。
  assert.deepEqual(
    equalSplit(12000, presentMemberIds(periods, "2026-08-04")),
    [
      { user_id: "a", amount_base_minor: 4000 },
      { user_id: "b", amount_base_minor: 4000 },
      { user_id: "c", amount_base_minor: 4000 },
    ],
  );
});
