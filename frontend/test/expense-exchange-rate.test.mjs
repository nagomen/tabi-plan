import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../src/", import.meta.url);
const source = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("費用フォームは支払日別レートをAPIから取得し、手入力させない", () => {
  const entry = source("dashboard/expense-entry.ts");
  const db = source("shared/db.ts");
  assert.match(entry, /name="fxRate"[\s\S]*readonly/);
  assert.match(entry, /db\.resolveExchangeRate\(planId\(\), paidOn, currency\)/);
  assert.match(entry, /await resolveRate\(true\)/);
  assert.match(entry, /resolvedRate\?\.fx_rate/);
  assert.doesNotMatch(entry, /fxRateFromUnitRate/);
  assert.match(db, /\/api\/plans\/\$\{encodeURIComponent\(planId\)\}\/exchange-rate/);
});
