import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("全APIリクエストに打ち切り時間があり、429は日本語と待ち時間で伝わる", () => {
  const db = read("src/shared/db.ts");
  assert.match(db, /AbortSignal\.timeout\(aiPath \? 90_000 : 30_000\)/);
  assert.match(db, /too many requests[\s\S]*アクセスが集中しています/);
  assert.match(db, /too many authentication attempts[\s\S]*試行回数が上限に達しました/);
  assert.match(db, /res\.headers\.get\("retry-after"\)/);
  assert.match(db, /res\.status === 429 && !retryable/);
});

test("裏の書き込み失敗と読み込み失敗は共通の帯へ通知される", () => {
  const db = read("src/shared/db.ts");
  assert.match(db, /function notifySyncError/);
  assert.match(db, /trip-sync-error/);
  assert.match(db, /bootstrap load failed/);
  const notice = read("src/shared/session-notice.ts");
  assert.match(notice, /addEventListener\("trip-sync-error"/);
  assert.match(notice, /addEventListener\("unhandledrejection"/);
  assert.match(notice, /SYNC_NOTICE_COOLDOWN_MS/);
});

test("計画の409衝突では自動保存を止め、上書きせずに読み込み直しを促す", () => {
  const editor = read("src/plan-editor/main.ts");
  assert.match(editor, /plan_version_conflict/);
  assert.match(editor, /versionConflictHalt/);
  assert.match(editor, /haltOnVersionConflict/);
  assert.match(editor, /読み込み直す/);
});

test("招待作成・参加期間・友達申請の失敗が利用者に見える", () => {
  const editor = read("src/plan-editor/main.ts");
  assert.match(editor, /招待リンクを作成できませんでした/);
  assert.match(editor, /参加期間を保存できませんでした/);
  const dashboard = read("src/dashboard/main.ts");
  assert.match(dashboard, /errorMessage\(error\) \|\| "作成できませんでした"/);
  const friendship = read("src/shared/friendship-store.ts");
  assert.match(friendship, /友達申請を送信できませんでした/);
});

test("ページ初期化の失敗が白画面・空表示のままにならない", () => {
  const dashboard = read("src/dashboard/main.ts");
  assert.match(dashboard, /void init\(\)\.catch/);
});

test("Service Workerは1件の取得失敗でオフライン対応を失わない", () => {
  const sw = read("public/sw.js");
  assert.match(sw, /Promise\.allSettled\(APP_SHELL\.map/);
  assert.match(sw, /statusText: "offline"/);
});
