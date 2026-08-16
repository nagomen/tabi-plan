import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadDurationHelpers() {
  const source = fs.readFileSync(new URL("src/shared/travel-duration.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports });
  return module.exports;
}

test("AIの所要分数を表示文字列へ変換しDB保存時に分へ戻せる", () => {
  const { formatDurationMinutes, parseDurationMinutes } = loadDurationHelpers();
  assert.equal(formatDurationMinutes(165), "2時間45分");
  assert.equal(parseDurationMinutes("2時間45分"), 165);
  assert.equal(parseDurationMinutes("1h40m"), 100);
  assert.equal(parseDurationMinutes("35分"), 35);
});

test("移動手段は独立フィールドで保存・復元される", () => {
  const editor = fs.readFileSync(new URL("src/plan-editor/main.ts", root), "utf8");
  const store = fs.readFileSync(new URL("src/shared/plans-store.ts", root), "utf8");
  assert.match(editor, /base\.transport = it\.transport/);
  assert.match(editor, /transport: String\(row\.transport/);
  assert.match(store, /origin: it\.from_place/);
  assert.match(store, /from_place: \(item\.origin/);
  assert.match(store, /duration_minutes: parseDurationMinutes\(item\.duration\)/);
});
