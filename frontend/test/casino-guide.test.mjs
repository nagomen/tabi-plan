import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const frontendRoot = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, frontendRoot), "utf8");

function loadBudgetModule() {
  const javascript = ts.transpileModule(read("src/casino-guide/budget.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, document: {} });
  return module.exports;
}

test("カジノ予算は回数で均等化し、小数の通貨単位を切り捨てる", () => {
  const { calculateSessionBudget } = loadBudgetModule();
  assert.equal(calculateSessionBudget("200000", "2"), 100000);
  assert.equal(calculateSessionBudget("100000", "3"), 33333);
});

test("カジノ予算は負数・過大値・不正な回数をUI制約内へ収める", () => {
  const { calculateSessionBudget } = loadBudgetModule();
  assert.equal(calculateSessionBudget("-5000", "2"), 0);
  assert.equal(calculateSessionBudget("999999999", "20"), 10000000);
  assert.equal(calculateSessionBudget("not-a-number", "0"), 0);
  assert.equal(calculateSessionBudget("999999999", "2", 10000000), 5000000);
});

test("カジノページのエントリーは機能別モジュールを組み立てるだけにする", () => {
  const main = read("src/casino-guide/main.ts");
  const app = read("src/casino-guide/app.ts");
  assert.match(main, /initializeCasinoGuidePage/);
  assert.doesNotMatch(main, /initializeSectionNavigation|initializePreparationChecklist|loadVenueMap/);
  assert.match(app, /import\("\.\/venue-map"\)/);
  assert.match(app, /initializeSectionNavigation/);
  assert.match(app, /initializePreparationChecklist/);
  assert.doesNotMatch(main, /L\.map|localStorage|querySelectorAll/);
});
