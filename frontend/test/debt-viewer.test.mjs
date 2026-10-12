import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("返済共有ページはhidden属性をCSSのdisplay指定より優先する", () => {
  const css = readFileSync(new URL("../src/debt/style.css", import.meta.url), "utf8");
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*;?\s*\}/);
});

test("返済共有ページは収入減と進路別の返済シナリオを表示する", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8");
  for (const marker of ["data-reduced-income-panel", "data-scenarios-panel", "data-repayment-scenarios"]) {
    assert.match(html, new RegExp(marker));
  }
  for (const field of ["reduced_income_months", "repayment_scenarios", "monthly_repayment_yen", "completion_date"]) {
    assert.match(viewer, new RegExp(field));
  }
  assert.match(viewer, /返済猶予/);
});

test("返済共有ページは返済原資と月次収支の内訳を表示する", () => {
  const html = readFileSync(new URL("../debt/index.html", import.meta.url), "utf8");
  const viewer = readFileSync(new URL("../src/debt/viewer.ts", import.meta.url), "utf8");
  for (const marker of ["data-funding-plan", "data-fixed-expenses", "data-variable-expenses", "data-monthly-buffer"]) {
    assert.match(html, new RegExp(marker));
  }
  for (const field of ["income_plan", "expense_plan", "funding_plan"]) {
    assert.match(viewer, new RegExp(field));
  }
});
