import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("公開旅行のリンク種別はSQLへ直書きせず明示的なポリシーで制限する", () => {
  const policy = read("src/public-plan-policy.ts");
  const bootstrap = read("src/bootstrap-repo.ts");
  assert.match(policy, /PUBLIC_PLAN_LINK_KEYS/);
  assert.match(policy, /"casinoGuide"/);
  assert.match(bootstrap, /inClause\(\[\.\.\.PUBLIC_PLAN_LINK_KEYS\]\)/);
  assert.doesNotMatch(bootstrap, /link_key IN \('itinerary'/);
});
