import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("予定を候補枠へ変換し、同じ時間の複数案を編集できる", () => {
  const days = read("src/plan-editor/days-render.ts");
  const actions = read("src/plan-editor/days-actions.ts");
  const candidates = read("src/plan-editor/candidates.ts");
  assert.match(days, /候補にする/);
  assert.match(days, /別の過ごし方を追加/);
  assert.match(actions, /convertItemToCandidateSlot/);
  assert.match(candidates, /slotId[\s\S]*date:[\s\S]*time:/);
});

test("旅行ページは投票後も全候補を保ち、マスターだけが終了できる", () => {
  const feed = read("src/dashboard/itinerary-feed.ts");
  const render = read("src/dashboard/render.ts");
  const db = read("src/shared/db.ts");
  assert.match(feed, /投票後も全候補を読んで変更できます/);
  assert.match(feed, /旅行マスターが終了すると/);
  assert.match(feed, /data-candidate-finalize/);
  assert.match(feed, /role="radiogroup"/);
  assert.match(render, /voteForCandidateSlot/);
  assert.match(render, /finalizeCandidateSlot/);
  assert.match(db, /candidate-slots\/\$\{encodeURIComponent\(slotId\)\}\/finalize/);
});
