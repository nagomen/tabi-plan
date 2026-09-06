import test from "node:test";
import assert from "node:assert/strict";

const { str, isRecord, arr, strArr, boundedNumber, safeDate } = await import("../dist/coerce.js");

test("文字列・配列・レコードの正規化はHTTP層とrepo層で同じ規則を使う", () => {
  assert.equal(str("a"), "a");
  assert.equal(str(1), "");
  assert.equal(str(undefined), "");

  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("x"), false);

  assert.deepEqual(arr([{ a: 1 }, "x", null, [2]]), [{ a: 1 }]);
  assert.deepEqual(arr("not-array"), []);

  assert.deepEqual(strArr([" a ", 1, "", "b"]), ["a", "b"]);
  assert.deepEqual(strArr("x"), []);
});

test("範囲付き数値と日付は空・不正・範囲外をnullへ落とす", () => {
  assert.equal(boundedNumber("22.5", -90, 90), 22.5);
  assert.equal(boundedNumber(-90, -90, 90), -90);
  assert.equal(boundedNumber(999, -90, 90), null);
  assert.equal(boundedNumber("", -90, 90), null);
  assert.equal(boundedNumber(null, -90, 90), null);
  assert.equal(boundedNumber(undefined, -90, 90), null);
  assert.equal(boundedNumber("abc", -90, 90), null);
  assert.equal(boundedNumber(Infinity, 0, 100000), null);

  assert.equal(safeDate("2026-10-09"), "2026-10-09");
  assert.equal(safeDate(" 2026-10-09 "), "2026-10-09");
  assert.equal(safeDate("2026/10/09"), null);
  assert.equal(safeDate(""), null);
  assert.equal(safeDate(null), null);
});
