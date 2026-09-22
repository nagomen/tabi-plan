import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("編集画面の期間と都市詳細をDB往復で保持する", () => {
  const planLoad = read("src/plan-editor/plan-load.ts");
  const planData = read("src/plan-editor/plan-data.ts");
  const store = read("src/shared/plans-store.ts");
  const database = read("src/shared/db.ts");
  assert.match(planData, /startDate: model\.startDate, endDate: model\.endDate/);
  assert.match(planLoad, /normalizeToISO\(trip\.startDate\)/);
  assert.match(planLoad, /itineraryDates\[0\]/);
  for (const field of ["from_date", "to_date", "lat", "lng"]) {
    assert.match(store, new RegExp(`${field}:`));
    assert.match(database, new RegExp(`${field}`));
  }
});

test("DBの0始まり日番号をDay N表示へ変換し、日付順のタブ名を崩さない", () => {
  const store = read("src/shared/plans-store.ts");
  const days = read("src/dashboard/days.ts");
  assert.match(store, /day: dayLabelFromIndex\(it\.day_index\)/);
  assert.match(store, /day_index: dayIndexFromLabel\(item\.day\)/);
  assert.match(store, /`Day \$\{dayIndex \+ 1\}`/);
  assert.match(days, /day: `Day \$\{index \+ 1\}`/);
  assert.doesNotMatch(days, /day: day\.day \|\| `Day/);
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
  const source = read("src/person/history-map.ts");
  assert.match(source, /if \(!personMap\) \{/);
  assert.match(source, /if \(personMap\) personMap\.remove\(\)/);
  assert.match(source, /filterEl\.dataset\.bound/);
});

test("人物地図の初期表示は直近の旅行に寄せ、以降は表示範囲を戻さない", () => {
  const map = read("src/person/history-map.ts");
  const main = read("src/person/main.ts");
  // ピンは全件描いたうえで、最初の表示範囲だけ直近の旅行に合わせる。
  assert.match(map, /const isFirstDraw = !personMap/);
  assert.match(map, /updateMapMarkers\(isFirstDraw \? "focus" : "keep"\)/);
  assert.match(map, /visit\.tripSlug === focusTripSlug/);
  assert.match(map, /if \(fit === "keep"\) return/);
  // 期間フィルタはその期間の全ピンに引き直す。
  assert.match(map, /updateMapMarkers\("all"\)/);
  // personTrips は新しい順なので先頭が直近の旅行。
  assert.match(main, /renderMap\(allPins, trips\[0\]\?\.plan\.slug \|\| ""\)/);
});

test("人物ページは名前ではなくuser_idで本人と作成計画を同定する", () => {
  const friendAction = read("src/person/friend-action.ts");
  const createdPlans = read("src/person/created-plans.ts");
  const membership = read("src/shared/membership.ts");
  // ?user= が来ていれば、同名アカウントが複数あっても申請先を決められる。
  assert.match(friendAction, /if \(personId\) \{\s*\n\s*const known = findAccountById\(personId\)/);
  assert.match(friendAction, /if \(personId\) return account\.id === personId/);
  // 作成した計画も owner の user_id で絞る。
  assert.match(createdPlans, /if \(personId\) return ownerIdOf\(meta\) === personId/);
  assert.match(membership, /export function ownerIdOf/);
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
