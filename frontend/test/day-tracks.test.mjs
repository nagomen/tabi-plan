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

const { memberSetKey, dayTracks, pickTrack, isItemInTrack, REST_TRACK_KEY } = load("src/shared/day-tracks.ts");

test("memberSetKey normalizes order/duplicates and treats empty as everyone", () => {
  assert.equal(memberSetKey(["b", "a", "b"]), "a,b");
  assert.equal(memberSetKey([]), null);
  assert.equal(memberSetKey(undefined), null);
  assert.equal(memberSetKey(["", "a"]), "a");
});

test("a day without subset items has no tracks (no tabs)", () => {
  assert.deepEqual([...dayTracks([undefined, [], undefined], ["a", "b"])], []);
});

test("one subset plus remaining present members splits into two tracks", () => {
  // ひろや・ユーマ(h,y)だけの移動がある日、在籍が h,y,me,k なら me,k が残り班になる。
  const tracks = dayTracks([["h", "y"], undefined, ["y", "h"]], ["h", "y", "me", "k"]);
  assert.equal(tracks.length, 2);
  assert.deepEqual([...tracks[0].memberIds], ["h", "y"]);
  assert.equal(tracks[1].key, REST_TRACK_KEY);
  assert.deepEqual([...tracks[1].memberIds], ["me", "k"]);
});

test("a subset covering everyone present yields no tabs", () => {
  assert.deepEqual([...dayTracks([["h", "y"]], ["h", "y"])], []);
});

test("two distinct subsets split into two tracks even without remaining members", () => {
  const tracks = dayTracks([["a", "b"], ["c"]], ["a", "b", "c"]);
  assert.equal(tracks.length, 2);
  // load() は VM 上で実行するため、戻り値の配列は別 realm。spread で比較する。
  assert.deepEqual([...tracks.map((t) => t.key)], ["a,b", "c"]);
});

test("pickTrack prefers the chosen key, then your own track, then the first", () => {
  const tracks = dayTracks([["a", "b"], ["c"]], ["a", "b", "c"]);
  assert.equal(pickTrack(tracks, "c", "a").key, "c");         // 明示選択が最優先
  assert.equal(pickTrack(tracks, undefined, "c").key, "c");   // 未選択なら自分の班
  assert.equal(pickTrack(tracks, "gone", "zz").key, "a,b");   // どちらも無ければ先頭
  assert.equal(pickTrack([], "x", "a"), null);
});

test("isItemInTrack shows everyone-items in every track and subset-items only in theirs", () => {
  const tracks = dayTracks([["a", "b"]], ["a", "b", "c"]);
  const groupAB = tracks[0];
  const rest = tracks[1];
  assert.equal(isItemInTrack(undefined, groupAB), true);
  assert.equal(isItemInTrack(undefined, rest), true);
  assert.equal(isItemInTrack(["b", "a"], groupAB), true);
  assert.equal(isItemInTrack(["a", "b"], rest), false);
});
