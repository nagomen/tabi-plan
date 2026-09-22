import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadMapTiles(context = {}) {
  const source = fs.readFileSync(new URL("src/shared/map-tiles.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, ...context });
  return module.exports;
}

test("map tiles switch to high resolution only at street-level zoom", () => {
  const { HIGH_RESOLUTION_TILE_MIN_ZOOM, tileDensityAtZoom } = loadMapTiles();

  assert.equal(HIGH_RESOLUTION_TILE_MIN_ZOOM, 12);
  assert.equal(tileDensityAtZoom(11), "standard");
  assert.equal(tileDensityAtZoom(12), "high");
  assert.equal(tileDensityAtZoom(18), "high");
});

test("map tiles respect data-saving and very slow connections", () => {
  const { tileDensityAtZoom } = loadMapTiles();

  assert.equal(tileDensityAtZoom(15, { saveData: true, effectiveType: "4g" }), "standard");
  assert.equal(tileDensityAtZoom(15, { effectiveType: "slow-2g" }), "standard");
  assert.equal(tileDensityAtZoom(15, { effectiveType: "2g" }), "standard");
  assert.equal(tileDensityAtZoom(15, { effectiveType: "3g" }), "high");
});

test("base layer uses separate standard and 2x zoom ranges", () => {
  const { addBaseLayer } = loadMapTiles();
  const calls = [];
  const map = {};
  const L = {
    tileLayer(url, options) {
      calls.push({ url, options });
      return { addTo(target) { assert.equal(target, map); } };
    },
  };

  addBaseLayer(L, map);

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/\{y\}\.png$/);
  assert.equal(calls[0].options.maxZoom, 11);
  assert.match(calls[1].url, /\/\{y\}@2x\.png$/);
  assert.equal(calls[1].options.minZoom, 12);
});

test("base layer avoids high-resolution downloads in data-saving mode", () => {
  const { addBaseLayer } = loadMapTiles({ navigator: { connection: { saveData: true } } });
  const calls = [];
  const L = {
    tileLayer(url, options) {
      calls.push({ url, options });
      return { addTo() {} };
    },
  };

  addBaseLayer(L, {});

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/\{y\}\.png$/);
  assert.equal(calls[0].options.maxZoom, 20);
});
