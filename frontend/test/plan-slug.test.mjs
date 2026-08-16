import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadModule() {
  const source = fs.readFileSync(new URL("src/shared/plan-slug.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module, exports: module.exports, Date, Math, Uint32Array,
    globalThis: { crypto: { getRandomValues: (values) => values.fill(123) } },
  });
  return module.exports;
}

test("新規計画slugは可視一覧の空き連番に依存しない", () => {
  const { collisionResistantPlanSlug } = loadModule();
  const taken = new Set(["trip", "trip-2", "trip-fixed0"]);
  const slug = collisionResistantPlanSlug("trip", (candidate) => taken.has(candidate), (attempt) => `fixed${attempt}`);
  assert.equal(slug, "trip-fixed1");
  assert.notEqual(slug, "trip-3");
});

test("新規計画slugはDBの64文字制約を超えない", () => {
  const { collisionResistantPlanSlug } = loadModule();
  const slug = collisionResistantPlanSlug("a".repeat(100), () => false, () => "token");
  assert.ok(slug.length <= 64);
  assert.match(slug, /-token$/);
});
