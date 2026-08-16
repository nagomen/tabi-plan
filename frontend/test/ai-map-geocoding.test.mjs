import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadModule() {
  const source = fs.readFileSync(new URL("src/plan-editor/ai-map-geocoding.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, Promise });
  return module.exports;
}

test("AI住所検索は順位1位を適用し、1件の失敗で残りを止めない", async () => {
  const { resolveAiMapGeocodeJobs } = loadModule();
  const applied = [];
  const jobs = ["成功A", "失敗", "0件", "成功B"].map((query) => ({
    query,
    apply: (result) => applied.push([query, result.label]),
  }));
  const summary = await resolveAiMapGeocodeJobs(jobs, async (query) => {
    if (query === "失敗") throw new Error("provider down");
    if (query === "0件") return [];
    return [
      { label: `${query} 住所1`, lat: 1, lng: 2 },
      { label: `${query} 住所2`, lat: 3, lng: 4 },
    ];
  }, 2);

  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { attempted: 4, resolved: 2, unresolved: 2 });
  assert.deepEqual(applied.sort(), [["成功A", "成功A 住所1"], ["成功B", "成功B 住所1"]]);
});

test("AI住所検索の同時実行数を上限内に保つ", async () => {
  const { resolveAiMapGeocodeJobs } = loadModule();
  let active = 0;
  let maximum = 0;
  const jobs = Array.from({ length: 8 }, (_, index) => ({ query: `場所${index}`, apply: () => {} }));
  await resolveAiMapGeocodeJobs(jobs, async (query) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    return [{ label: query, lat: 1, lng: 2 }];
  }, 3);
  assert.ok(maximum <= 3);
  assert.ok(maximum >= 2);
});

