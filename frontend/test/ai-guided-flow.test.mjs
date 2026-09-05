import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("AI相談は候補・条件・完成の3段階で終了する", () => {
  const html = read("plan-editor.html");
  assert.match(html, /data-ai-flow="candidates"/);
  assert.match(html, /data-ai-flow="preferences"/);
  assert.match(html, /data-ai-flow="done"/);
  assert.match(html, /data-ai-candidate-list/);
  assert.match(html, /data-ai-build/);
  assert.match(html, /data-ai-show-itinerary/);
  assert.doesNotMatch(html, /data-ai-send|さらに質問/);
});

test("候補選択と指定条件を1回の最終行程生成へ渡す", () => {
  const editor = read("src/plan-editor/main.ts");
  const db = read("src/shared/db.ts");
  const state = read("src/plan-editor/ai-consultation-state.ts");
  assert.match(editor, /await db\.suggestItineraryOptions\(input\)/);
  assert.match(editor, /selected_candidate_ids: selected\.map/);
  assert.match(editor, /consultation_token: aiConsultation\.options/);
  assert.match(editor, /preferences: aiPreferences\(\)/);
  assert.match(editor, /setAiStage\("done"\)/);
  assert.match(editor, /function aiCandidateGroups\(\)/);
  assert.match(editor, /function unselectedAiCities\(\)/);
  assert.match(editor, /各都市から1件以上/);
  assert.match(db, /"POST", "\/api\/ai\/itinerary-options"/);
  assert.match(db, /"POST", "\/api\/ai\/itinerary"/);
  assert.match(state, /class AiConsultationState/);
  assert.match(state, /unselectedCities\(\)/);
  assert.match(editor, /const saved = await persist\(true\)/);
  assert.match(editor, /await registerAiDraftPlacesOnMap\(\)/);
  assert.match(editor, /item\.mapQuery = result\.label/);
  assert.match(editor, /mapQuery: item\.kind === "move"[\s\S]*item\.address/);
  assert.match(editor, /lat: aiCoordinate\(item\.latitude/);
  assert.match(editor, /setAiStatus\(saved \? ""/);
  assert.doesNotMatch(editor, /地図住所の自動登録はMapbox未設定/);
});

test("AIで登録した移動端点の座標もDB往復で保持する", () => {
  const store = read("src/shared/plans-store.ts");
  assert.match(store, /originLat: it\.from_lat == null \? undefined : Number\(it\.from_lat\)/);
  assert.match(store, /destinationLat: it\.to_lat == null \? undefined : Number\(it\.to_lat\)/);
  assert.match(store, /from_lat: num\(item\.originLat\)/);
  assert.match(store, /to_lat: num\(item\.destinationLat\)/);
  assert.match(store, /String\(v\)\.trim\(\) === ""\) return null/);
});

test("旅行詳細では編集メンバーだけが全日程対応のAIチャットを使える", () => {
  const html = read("index.html");
  const dashboard = read("src/dashboard/main.ts");
  const db = read("src/shared/db.ts");
  const style = read("src/dashboard/style.css");
  assert.match(html, /data-day-title[\s\S]*data-ai-support[\s\S]*AIサポート/);
  assert.match(html, /data-ai-chat[\s\S]*data-ai-chat-log[\s\S]*data-ai-chat-form/);
  assert.match(dashboard, /if \(aiSupport && editTarget && isEditableLocalPlan\(\)\)/);
  assert.match(dashboard, /aiSupport\.hidden = false/);
  assert.match(dashboard, /setupAiChat\(aiSupport\)/);
  assert.match(dashboard, /current_itinerary: latestAiItinerary\(\)/);
  assert.match(dashboard, /members: Array\.isArray\(item\.members\)/);
  assert.match(dashboard, /cities: citiesForAiRefinement\(\)/);
  assert.match(dashboard, /members: membersForAiRefinement\(\)/);
  assert.match(dashboard, /ItineraryRefineCity/);
  assert.match(dashboard, /ItineraryRefineMember/);
  assert.match(dashboard, /await db\.refineItinerary/);
  assert.match(dashboard, /この提案を行程に反映/);
  assert.match(dashboard, /await db\.flushMutations\(checkpoint\)/);
  assert.match(db, /"POST", "\/api\/ai\/itinerary-refine"/);
  assert.match(style, /\.tl-ai-support \{[\s\S]*border-radius: 999px/);
  assert.match(style, /\.tl-ai-chat \{[\s\S]*\.tl-ai-message\.is-user/);
  assert.match(style, /\.tl-day-title \.tl-ai-support \{[\s\S]*grid-column: 3/);
});
