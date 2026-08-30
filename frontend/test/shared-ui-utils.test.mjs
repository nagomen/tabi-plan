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
  vm.runInNewContext(javascript, { module, exports: module.exports, Date });
  return module.exports;
}

test("expense choices are normalized consistently for the expense form", () => {
  const { expenseParticipantNames, expenseCurrencyCodes } = load("src/shared/expense-form.ts");
  assert.deepEqual(
    Array.from(expenseParticipantNames({ participants: [{ displayName: " Alice " }, { "表示名": "Bob" }] })),
    ["Alice", "Bob"],
  );
  assert.deepEqual(
    Array.from(expenseParticipantNames({ trip: { members: "Alice / Bob、Alice" } })),
    ["Alice", "Bob"],
  );
  assert.deepEqual(
    Array.from(expenseCurrencyCodes({ localInfo: [{ currencyCode: "cny" }] }, ["JPY", "usd"])),
    ["JPY", "USD", "CNY"],
  );
});

test("shared month calendar escapes labels and always renders six weeks", () => {
  const { monthCalendarHtml } = load("src/shared/calendar.ts");
  const html = monthCalendarHtml({
    year: 2026,
    month: 7,
    today: new Date(2026, 7, 16),
    classPrefix: "test",
    bands: [{
      slug: "summer-trip",
      title: "A&B <trip>",
      start: new Date(2026, 7, 15),
      end: new Date(2026, 7, 17),
      color: "#123456",
    }],
  });
  assert.equal((html.match(/<div class="test-cell/g) || []).length, 42);
  assert.match(html, /A&amp;B &lt;trip&gt;/);
  assert.doesNotMatch(html, /A&B <trip>/);
});

test("local date helper honors an explicit override", () => {
  const { localDateISO } = load("src/shared/date.ts");
  assert.equal(localDateISO("2026-10-08", new Date(2000, 0, 1)), "2026-10-08");
  assert.equal(localDateISO("", new Date(2026, 7, 16)), "2026-08-16");
});
