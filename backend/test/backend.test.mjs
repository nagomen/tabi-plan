import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const source = (name) => fs.readFileSync(new URL(`src/${name}`, root), "utf8");

function settlementFunctions() {
  const code = [source("config.ts"), source("util.ts"), source("participants.ts"), source("settlement.ts")].join("\n") + `
    globalThis.__tested = { allocateExpense_, buildTransfers_ };
  `;
  const javascript = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  const context = { console };
  vm.runInNewContext(javascript, context);
  return context.__tested;
}

test("itinerary reader includes the visibility column instead of using a fixed width", () => {
  const config = source("config.ts");
  const dashboard = source("dashboard.ts");
  const itinerary = source("itinerary.ts");
  assert.match(config, /const ITINERARY_HEADERS[\s\S]*'天気'[\s\S]*'公開ページに表示'/);
  assert.match(itinerary, /const headers = ITINERARY_HEADERS/);
  assert.match(dashboard, /readObjects_\([^\n]*itinerary[^\n]*, 2, 1\)/);
  assert.doesNotMatch(dashboard, /itinerary[^\n]*, 2, 1, 24\)/);
});

test("Apps Script authentication is POST-only", () => {
  const main = source("main.ts");
  assert.doesNotMatch(main.match(/const GET_ACTIONS[\s\S]*?};/)?.[0] || "", /auth\s*:/);
  assert.match(main.match(/const POST_ACTIONS[\s\S]*?};/)?.[0] || "", /auth:\s*\{[^}]*handleAuth_/);
});

test("spreadsheet contracts are shared by setup and published-trip provisioning", () => {
  const config = source("config.ts");
  const setup = source("setup.ts");
  const createTrip = source("create-trip.ts");
  for (const contract of ["BASIC_INFO_HEADERS", "RESERVATION_HEADERS", "BUDGET_HEADERS", "CHECKLIST_HEADERS"]) {
    assert.match(config, new RegExp(`const ${contract} =`));
    assert.match(setup, new RegExp(contract));
    assert.match(createTrip, new RegExp(contract));
  }
});

test("expense form setup uses one shared context loader", () => {
  const setup = source("setup.ts");
  assert.match(setup, /function expenseFormContext_/);
  assert.equal((setup.match(/expenseFormContext_\(\)/g) || []).length, 3);
  assert.doesNotMatch(setup, /TRIP_EXPENSE_FORM_URL/);
});

test("settlement allocation applies participant weights and preserves the total", () => {
  const { allocateExpense_ } = settlementFunctions();
  const result = allocateExpense_("全員で等分", "A", ["A", "B"], [], [], 300, { A: 1, B: 2 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.shares)),
    [{ name: "A", amount: 100 }, { name: "B", amount: 200 }],
  );
  assert.equal(result.shares.reduce((sum, share) => sum + share.amount, 0), 300);
});

test("custom settlement amounts are not reweighted", () => {
  const { allocateExpense_ } = settlementFunctions();
  const custom = [{ name: "A", amount: 80 }, { name: "B", amount: 220 }];
  const result = allocateExpense_("個別金額を入力", "A", ["A", "B"], [], custom, 300, { A: 1, B: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.shares)), custom);
});
