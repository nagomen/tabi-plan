import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("編集画面の期間と都市詳細をDB往復で保持する", () => {
  const editor = read("src/plan-editor/main.ts");
  const store = read("src/shared/plans-store.ts");
  const database = read("src/shared/db.ts");
  assert.match(editor, /startDate: model\.startDate, endDate: model\.endDate/);
  assert.match(editor, /normalizeToISO\(trip\.startDate\)/);
  assert.match(editor, /itineraryDates\[0\]/);
  for (const field of ["from_date", "to_date", "lat", "lng"]) {
    assert.match(store, new RegExp(`${field}:`));
    assert.match(database, new RegExp(`${field}`));
  }
});

test("公開共同編集者はメタPATCHを送らず行程と都市だけを保存する", () => {
  const store = read("src/shared/plans-store.ts");
  const editor = read("src/plan-editor/main.ts");
  assert.match(store, /const patch = canEditMetadata \? requestedPatch : \{\}/);
  assert.match(store, /\{ itinerary: planContent\.itinerary, cities: planContent\.cities \}/);
  assert.match(editor, /applyMetadataLock/);
  assert.match(editor, /canEditPlanMetadata/);
});

test("APIモードの友達状態はlocalStorageと混ぜず、API成功後だけ更新する", () => {
  const source = read("src/shared/friendship-store.ts");
  assert.match(source, /if \(db\.isEnabled\(\)\) return "none"/);
  assert.match(source, /await db\.saveFriendship/);
  assert.match(source, /db\.isEnabled\(\) \? \[\] : readStore\(\)/);
  assert.doesNotMatch(source, /void db\.saveFriendship/);
  const database = read("src/shared/db.ts");
  assert.match(database, /emit\(\{ ok: true, path: "\/api\/friendships" \}\)/);
});

test("Service Workerは認証済みAPI応答をキャッシュしない", () => {
  const source = read("public/sw.js");
  assert.match(source, /url\.pathname\.startsWith\("\/api\/"\)/);
});

test("人物地図の再描画は既存Leafletインスタンスを再生成しない", () => {
  const source = read("src/person/main.ts");
  assert.match(source, /if \(!personMap\) \{/);
  assert.match(source, /if \(personMap\) personMap\.remove\(\)/);
  assert.match(source, /filterEl\.dataset\.bound/);
});

test("fresh loadとセッション通知の優先度を守る", () => {
  const database = read("src/shared/db.ts");
  const notice = read("src/shared/session-notice.ts");
  assert.match(database, /if \(loaded && !options\.fresh\) return/);
  assert.match(notice, /priority !== "session"/);
  assert.match(notice, /replaceWith\(build/);
});

test("ページ遷移はHTMLとディレクトリURLだけを対象にする", () => {
  const source = read("src/shared/page-transition.ts");
  assert.match(source, /url\.pathname\.endsWith\("\/"\)/);
  assert.doesNotMatch(source, /\|\| url\.origin === location\.origin/);
});
