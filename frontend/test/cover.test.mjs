import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

// cover.ts は plans-store を import するので、require をスタブして純ロジックだけ検証する。
function load(relativePath, stubs = {}) {
  const source = fs.readFileSync(new URL(relativePath, root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    require: (id) => stubs[id] || {},
  });
  return module.exports;
}

const { coverImageForLocation, planCoverImageForLocation } = load("src/shared/cover.ts", {
  "./plans-store": { getData: () => null },
});

test("Hong Kong area names map to the Hong Kong cover", () => {
  assert.equal(coverImageForLocation("香港"), "./images/cover_hongkong.webp");
  assert.equal(coverImageForLocation("尖沙咀"), "./images/cover_hongkong.webp");
  assert.equal(coverImageForLocation("九龍"), "./images/cover_hongkong.webp");
  assert.equal(coverImageForLocation("Tsim Sha Tsui Promenade"), "./images/cover_hongkong.webp");
});

test("Macau areas map to China, not Thailand (コタイ≠タイ)", () => {
  assert.equal(coverImageForLocation("マカオ"), "./images/cover_china.webp");
  assert.equal(coverImageForLocation("コタイ（ザ・ベネチアン・マカオ）"), "./images/cover_china.webp");
  assert.equal(coverImageForLocation("Cotai"), "./images/cover_china.webp");
  assert.equal(coverImageForLocation("Macau"), "./images/cover_china.webp");
  // 素のタイは従来どおりタイ。
  assert.equal(coverImageForLocation("タイ・バンコク"), "./images/cover_thailand.webp");
});

test("深圳 (kanji spelling) maps to China", () => {
  assert.equal(coverImageForLocation("深圳"), "./images/cover_china.webp");
  assert.equal(coverImageForLocation("福田〜南山エリアは判定不能"), "./images/cover_default.webp");
});

test("short country/state codes no longer match inside other words", () => {
  assert.equal(coverImageForLocation("Fukuoka"), "./images/cover_fukuoka.webp"); // uk に誤一致しない
  assert.equal(coverImageForLocation("タイムズスクエア"), "./images/cover_newyork.webp"); // タイに誤一致しない
  assert.equal(coverImageForLocation("uk"), "./images/cover_uk.webp"); // 単独の略称は従来どおり
});

test("planCoverImageForLocation tries candidates in order and falls back to the plan", () => {
  const meta = { slug: "x", route: "香港", title: "", cover: "" };
  // 判定できない地名はスキップして、次の候補で決める。
  assert.equal(
    planCoverImageForLocation(meta, ["福田〜南山エリア", "深圳"]),
    "./images/cover_china.webp",
  );
  // どの候補も判定できなければ、汎用デフォルトではなく計画全体（route=香港）で決める。
  assert.equal(
    planCoverImageForLocation(meta, ["謎のエリア"]),
    "./images/cover_hongkong.webp",
  );
  // 手動設定のカバーは常に最優先。
  assert.equal(
    planCoverImageForLocation({ ...meta, cover: "./images/custom.webp" }, ["深圳"]),
    "./images/custom.webp",
  );
});
