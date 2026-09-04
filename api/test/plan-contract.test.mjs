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
});
