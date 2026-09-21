import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadValidation() {
  const source = fs.readFileSync(new URL("src/plan-editor/validation.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports });
  return module.exports;
}

function loadTypeScriptModule(path) {
  const source = fs.readFileSync(new URL(path, root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, Promise });
  return module.exports;
}

test("publish validation keeps incomplete plans as drafts", () => {
  const { validatePublishPlan } = loadValidation();
  assert.equal(validatePublishPlan({ title: "", startDate: "", endDate: "", cities: [] }).field, "title");
  assert.equal(validatePublishPlan({ title: "台湾旅行", startDate: "", endDate: "", cities: [] }).field, "dates");
  assert.equal(validatePublishPlan({
    title: "台湾旅行", startDate: "2026-10-08", endDate: "2026-10-13", cities: [],
  }).field, "cities");
  assert.equal(validatePublishPlan({
    title: "台湾旅行", startDate: "2026-10-08", endDate: "2026-10-13", cities: [{ name: "金門島" }],
  }), null);
  assert.equal(validatePublishPlan({
    title: "台湾旅行", startDate: "2026-02-31", endDate: "2026-03-02", cities: [{ name: "台北" }],
  }).field, "dates");
});

test("editor separates draft save from publishing and waits before inviting", () => {
  const source = fs.readFileSync(new URL("src/plan-editor/main.ts", root), "utf8");
  const savePublish = fs.readFileSync(new URL("src/plan-editor/save-publish.ts", root), "utf8");
  const persist = fs.readFileSync(new URL("src/plan-editor/persist.ts", root), "utf8");
  const members = fs.readFileSync(new URL("src/plan-editor/members.ts", root), "utf8");
  assert.match(savePublish, /async function save\(\)[\s\S]*await persist\(true\)/);
  assert.doesNotMatch(savePublish, /async function save\(\)[\s\S]{0,500}published: true/);
  assert.match(members, /async function shareInvite[\s\S]*await persist\(true\)/);
  assert.match(persist, /contentChanged[\s\S]*TripPlans\.saveLocalPlan[\s\S]*TripPlans\.upsert/);
  assert.match(source, /strict: db\.isEnabled\(\)/);
});

test("new-plan form respects database length contracts", () => {
  const html = fs.readFileSync(new URL("plan-editor.html", root), "utf8");
  assert.match(html, /data-f="title" maxlength="120"/);
  assert.match(html, /data-city-input[^>]*maxlength="100"/);
  assert.match(html, /data-cand-input[^>]*maxlength="200"/);
  assert.match(html, /data-save>下書きを保存/);
  assert.match(html, /data-publish-plan>公開設定/);
});

test("slug競合時は入力内容を保ったまま別URLで保存を再試行する", () => {
  const source = fs.readFileSync(new URL("src/plan-editor/persist.ts", root), "utf8");
  assert.match(source, /error\.code === "ER_DUP_ENTRY"/);
  assert.match(source, /return performPersist\(explicit, slugRetry \+ 1\)/);
});

test("公開前の保存中に編集されても最新revisionまで保存を繰り返す", async () => {
  const { saveLatestRevision } = loadTypeScriptModule("src/plan-editor/save-stability.ts");
  let revision = 1;
  let calls = 0;
  const saved = await saveLatestRevision(async () => {
    calls += 1;
    if (calls === 1) revision += 1;
    return true;
  }, () => revision);
  assert.equal(saved, true);
  assert.equal(calls, 2);
});

test("新規計画はメンバーと本文を作成POSTへ同梱する", () => {
  const database = fs.readFileSync(new URL("src/shared/db.ts", root), "utf8");
  const plans = fs.readFileSync(new URL("src/shared/plans-store.ts", root), "utf8");
  assert.match(database, /createPlanBundleLocal[\s\S]*send\("POST", "\/api\/plans", \{ \.\.\.row, members, content: identifiedContent \}\)/);
  assert.match(plans, /!existing && db\.isEnabled\(\)[\s\S]*createPlanBundleLocal/);
});

test("ブラウザ版の行程保存はDB行IDを保持して差分更新できる", () => {
  const types = fs.readFileSync(new URL("src/shared/types.ts", root), "utf8");
  const load = fs.readFileSync(new URL("src/plan-editor/plan-load.ts", root), "utf8");
  const data = fs.readFileSync(new URL("src/plan-editor/plan-data.ts", root), "utf8");
  const database = fs.readFileSync(new URL("src/shared/db.ts", root), "utf8");
  assert.match(types, /itemId\?: string/);
  assert.match(load, /storageIds: row\.itemId \? \[row\.itemId\] : \[\]/);
  assert.match(load, /prev\.storageIds\.push\(\.\.\.cur\.storageIds\)/);
  assert.match(data, /newItineraryStorageId/);
  assert.match(data, /di - cover\.startIndex/);
  assert.match(database, /id: it\.id \|\| localId\("itm"\)/);
});

test("友達以外を名前で追加し、保存後に未登録メンバーとして招待できる", () => {
  const html = fs.readFileSync(new URL("plan-editor.html", root), "utf8");
  const editor = fs.readFileSync(new URL("src/plan-editor/members.ts", root), "utf8");
  const plans = fs.readFileSync(new URL("src/plans/invite-join.ts", root), "utf8");
  assert.match(html, /data-member-name/);
  assert.match(html, /名前で追加/);
  assert.match(editor, /pendingMembers/);
  assert.match(editor, /db\.createPlaceholderMember/);
  assert.match(editor, /未登録/);
  assert.match(plans, /旅行メンバーの中で、あなたは誰ですか/);
  assert.match(plans, /db\.inspectInvite/);
  assert.match(plans, /db\.acceptInvite\(payload\.token, selectedMemberId\)/);
  assert.match(editor, /data-revoke-invite/);
  assert.match(editor, /navigator\.share[\s\S]*db\.revokeInvite/);
  assert.match(editor, /undoPlaceholderClaim/);
  assert.match(html, /data-member-role/);
  assert.match(html, /編集できる/);
  assert.match(html, /閲覧のみ/);
  assert.match(editor, /access_status === "active"/);
  assert.match(editor, /data-member-role-id/);
  assert.match(editor, /data-revoke-access/);
  assert.match(editor, /db\.revokeMemberAccess/);
  assert.match(editor, /data-rm=/);
  assert.match(editor, /db\.removePlanMember/);
  assert.match(editor, /data-transfer-owner[\s\S]{0,300}access_status === "active"|access_status === "active"[\s\S]{0,300}data-transfer-owner/);
});

test("ownerはダッシュボードの参加者一覧から本人以外を即時削除できる", () => {
  const html = fs.readFileSync(new URL("index.html", root), "utf8");
  const dashboard = fs.readFileSync(new URL("src/dashboard/members.ts", root), "utf8");
  const main = fs.readFileSync(new URL("src/dashboard/main.ts", root), "utf8");
  const database = fs.readFileSync(new URL("src/shared/db.ts", root), "utf8");
  assert.match(html, /data-members-status aria-live="polite"/);
  assert.match(dashboard, /canManagePlan\(meta\)/);
  assert.match(dashboard, /data-remove-member=/);
  assert.match(dashboard, /!owner && !self/);
  assert.match(dashboard, /db\.removePlanMember\(meta\.id, userId\)/);
  assert.match(main, /\[data-remove-member\]/);
  assert.match(database, /DELETE[\s\S]*\/members\/\$\{encodeURIComponent\(userId\)\}/);
});

test("ダッシュボードで名前・参加期間・旅程分類を登録し、本人専用招待を再送できる", () => {
  const html = fs.readFileSync(new URL("index.html", root), "utf8");
  const dashboard = fs.readFileSync(new URL("src/dashboard/members.ts", root), "utf8");
  assert.match(html, /data-invite-name[^>]*required/);
  assert.match(html, /data-invite-track/);
  assert.match(html, /data-invite-from/);
  assert.match(html, /data-invite-to/);
  assert.match(html, /追加して招待リンクを共有/);
  assert.match(dashboard, /db\.createPlaceholderMember\(meta\.id, name, role, \{ fromDate, toDate, trackMemberIds \}\)/);
  assert.match(dashboard, /invited_user_id: userId/);
  assert.match(dashboard, /data-invite-member=/);
  assert.match(dashboard, /revokeCreatedInvite[\s\S]*db\.revokeInvite\(planId, createdInviteId\)/);
  assert.match(dashboard, /navigator\.share[\s\S]*revokeCreatedInvite\("招待は未送信です"\)/);
  assert.match(dashboard, /window\.prompt[\s\S]*copied === null[\s\S]*revokeCreatedInvite/);
});

test("API利用時は表示名だけでグローバルユーザーを自動作成しない", () => {
  const database = fs.readFileSync(new URL("src/shared/db.ts", root), "utf8");
  const plans = fs.readFileSync(new URL("src/shared/plans-store.ts", root), "utf8");
  assert.doesNotMatch(database, /send\("POST", "\/api\/users"/);
  assert.match(database, /if \(isEnabled\(\)\) throw new Error\("登録済みの旅行メンバーから選択してください"\)/);
  assert.match(plans, /!db\.isEnabled\(\) \? db\.ensureUserLocal\(name\) : undefined/);
});

test("LINEログインでも招待tokenを外部へ送らずブラウザ内で選択状態を復元する", () => {
  const database = fs.readFileSync(new URL("src/shared/db.ts", root), "utf8");
  assert.match(database, /LINE_RETURN_HASH_KEY/);
  assert.match(database, /rememberLineReturnHash\(returnTo, nonce\)/);
  assert.match(database, /takeLineReturnHash\(nonce\)/);
  assert.match(database, /url\.origin !== location\.origin/);
  assert.doesNotMatch(database, /return_to:\s*returnTo[\s\S]{0,100}join/);
});

test("招待参加後は最新セッションを解決し、旧端末用の空の本人選択を出さない", () => {
  const database = fs.readFileSync(new URL("src/shared/db.ts", root), "utf8");
  const dashboard = fs.readFileSync(new URL("src/dashboard/main.ts", root), "utf8");
  const profile = fs.readFileSync(new URL("src/dashboard/profile.ts", root), "utf8");
  const html = fs.readFileSync(new URL("index.html", root), "utf8");
  assert.match(database, /sessionRequiresViewerResolution/);
  assert.match(database, /!options\.fresh && !sessionRequiresViewerResolution\(\)/);
  assert.match(dashboard, /db\.load\(\{ fresh: db\.isEnabled\(\), strict: db\.isEnabled\(\) \}\)/);
  assert.match(profile, /if \(db\.isEnabled\(\)\)[\s\S]{0,300}login\.html\?returnTo=/);
  assert.match(html, /追加して招待リンクを共有/);
  assert.match(html, /本人専用の招待リンク/);
});

test("MySQL運用では静的設定から旅行を自動作成しない", () => {
  const plans = fs.readFileSync(new URL("src/shared/plans-store.ts", root), "utf8");
  assert.match(plans, /if \(db\.isEnabled\(\)\) return;/);
  assert.match(plans, /!db\.isEnabled\(\) \? seedMeta\(config\) : null/);
});
