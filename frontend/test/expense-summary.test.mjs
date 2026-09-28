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
  vm.runInNewContext(javascript, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const { buildExpenseShareText, buildExpensePrintHtml } = load("src/shared/expense-summary.ts");

const input = {
  trip: { title: "台北旅行", dates: "2027/5/1 - 5/3" },
  generatedAt: new Date("2027-05-04T10:30:00+09:00"),
  settlement: {
    expenseTotal: "¥12,000",
    transfers: [{ from: "ゆう", to: "あき", amount: 6000, amountLabel: "¥6,000" }],
    settlementHistory: [{ date: "2027-05-02", from: "そら", to: "あき", amount: 1000, amountLabel: "¥1,000" }],
    expenseDetails: [{
      date: "2027-05-01", payer: "あき", category: "交通", title: "空港タクシー",
      mode: "立て替え", amountLabel: "TWD 2,400", convertedLabel: "¥12,000", myShareLabel: "¥0",
      isAdvance: true, targetNames: ["ゆう"], shares: [{ name: "ゆう", amount: 12000, amountLabel: "¥12,000" }],
    }],
  },
};

test("共有文はアプリ外の相手だけで精算額と立替内訳を理解できる", () => {
  const text = buildExpenseShareText(input);
  assert.match(text, /【台北旅行｜費用・精算明細】/);
  assert.match(text, /ゆう → あき: ¥6,000/);
  assert.match(text, /空港タクシー: ¥12,000/);
  assert.match(text, /立替先: ゆう ¥12,000/);
  assert.match(text, /精算済み（1件）/);
});

test("PDF用文書はA4印刷向けで、明細をHTMLエスケープする", () => {
  const html = buildExpensePrintHtml({
    ...input,
    trip: { ...input.trip, title: "<台北&旅行>" },
  });
  assert.match(html, /@page \{ size: A4/);
  assert.match(html, /&lt;台北&amp;旅行&gt;/);
  assert.match(html, /現在の精算/);
  assert.match(html, /立替先/);
  assert.doesNotMatch(html, /<h1><台北&旅行><\/h1>/);
});
