import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { MAX_COVER_VALUE_LENGTH, planFieldError } = await import("../dist/plan-contract.js");
const { validatePlanContent } = await import("../dist/plan-repo.js");

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
  assert.match(planFieldError({ start_date: "2026-02-31" }), /日付/);
  assert.match(planFieldError({ start_date: "2026-09-10", end_date: "2026-09-01" }), /開始日/);
  assert.match(planFieldError({ visibility: "friends" }), /公開範囲/);
  assert.match(planFieldError({ status: "archived" }), /公開状態/);
  assert.match(planFieldError({ dates_label: "日".repeat(65) }), /64/);
});

test("plan content reports the exact invalid row before reaching MySQL", () => {
  assert.throws(
    () => validatePlanContent({ itinerary: [{ kind: "unknown", title: "予定" }] }),
    /行程1件目の種別/,
  );
  assert.throws(
    () => validatePlanContent({ itinerary: [{ kind: "sight", start_time: "29:80" }] }),
    /行程1件目の時刻/,
  );
  assert.throws(
    () => validatePlanContent({ checklist: [{ label: "確認", status: "later" }] }),
    /チェックリスト1件目の状態/,
  );
  assert.throws(
    () => validatePlanContent({ links: [{ link_key: "map", label: "地図", url: "javascript:alert(1)" }] }),
    /リンク1件目のURL/,
  );
  assert.throws(
    () => validatePlanContent({ cities: [{ name: "東京", secret: "x" }] }),
    /訪問地1件目.*更新できない項目.*secret/,
  );
});
