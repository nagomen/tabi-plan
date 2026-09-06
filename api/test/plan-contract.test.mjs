import test from "node:test";
import assert from "node:assert/strict";
import { MAX_COVER_VALUE_LENGTH, planFieldError } from "../dist/plan-contract.js";

test("plan fields are rejected before violating storage contracts", () => {
  assert.match(planFieldError({ title: "旅".repeat(121) }), /120/);
  assert.match(planFieldError({ note: "メ".repeat(5001) }), /5000/);
  assert.match(planFieldError({ cover_url: "x".repeat(MAX_COVER_VALUE_LENGTH + 1) }), /大きすぎ/);
  assert.match(planFieldError({ cover_url: "data:image/svg+xml;base64,PHN2Zz4=" }), /形式/);
  assert.equal(planFieldError({ cover_url: "data:image/webp;base64,UklGRg==" }), "");
  assert.equal(planFieldError({ source: "local" }), "");
  assert.match(planFieldError({ source: "sample" }), /変更できません/);
  assert.match(planFieldError({ source: null }), /変更できません/);
  // slugはURLと一意キーに使うため、フロントのsafeTripSlugと同じ字種に限る。
  assert.equal(planFieldError({ slug: "trip-10" }), "");
  assert.match(planFieldError({ slug: "Trip_10" }), /スラッグ/);
  assert.match(planFieldError({ slug: `${"a".repeat(65)}` }), /スラッグ/);
  assert.match(planFieldError({ slug: "" }), /スラッグ/);
  assert.match(planFieldError({ start_date: "2026/08/01" }), /日付/);
  assert.equal(planFieldError({ start_date: "2026-08-01", end_date: "" }), "");
  assert.match(planFieldError({ base_currency: "円" }), /通貨/);
  assert.equal(planFieldError({ base_currency: "usd" }), "");
});
