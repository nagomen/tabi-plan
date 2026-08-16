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
