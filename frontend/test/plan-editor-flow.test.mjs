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
});

test("editor separates draft save from publishing and waits before inviting", () => {
  const source = fs.readFileSync(new URL("src/plan-editor/main.ts", root), "utf8");
  assert.match(source, /async function save\(\)[\s\S]*await persist\(true\)/);
  assert.doesNotMatch(source, /async function save\(\)[\s\S]{0,500}published: true/);
  assert.match(source, /async function shareInvite[\s\S]*await persist\(true\)/);
  assert.match(source, /contentChanged[\s\S]*TripPlans\.saveLocalPlan[\s\S]*TripPlans\.upsert/);
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
  const source = fs.readFileSync(new URL("src/plan-editor/main.ts", root), "utf8");
  assert.match(source, /error\.code === "ER_DUP_ENTRY"/);
  assert.match(source, /return performPersist\(explicit, slugRetry \+ 1\)/);
});

test("友達以外を名前で追加し、保存後に未登録メンバーとして招待できる", () => {
  const html = fs.readFileSync(new URL("plan-editor.html", root), "utf8");
  const editor = fs.readFileSync(new URL("src/plan-editor/main.ts", root), "utf8");
  const plans = fs.readFileSync(new URL("src/plans/main.ts", root), "utf8");
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
  const html = fs.readFileSync(new URL("index.html", root), "utf8");
  assert.match(database, /sessionRequiresViewerResolution/);
  assert.match(database, /!options\.fresh && !sessionRequiresViewerResolution\(\)/);
  assert.match(dashboard, /db\.load\(\{ fresh: db\.isEnabled\(\), strict: db\.isEnabled\(\) \}\)/);
  assert.match(dashboard, /if \(db\.isEnabled\(\)\)[\s\S]{0,300}login\.html\?returnTo=/);
  assert.match(html, /招待リンクを発行して共有/);
  assert.match(html, /ブラウザに表示中のURLでは参加できません/);
});

test("MySQL運用では静的設定から旅行を自動作成しない", () => {
  const plans = fs.readFileSync(new URL("src/shared/plans-store.ts", root), "utf8");
  assert.match(plans, /if \(db\.isEnabled\(\)\) return;/);
  assert.match(plans, /!db\.isEnabled\(\) \? seedMeta\(config\) : null/);
});
