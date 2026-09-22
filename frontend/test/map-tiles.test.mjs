import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const source = fs.readFileSync(new URL("src/shared/map-tiles.ts", root), "utf8");

function loadMapTiles(connection) {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, {
    module,
    exports: module.exports,
    navigator: connection ? { connection } : {},
    console,
  });
  return module.exports;
}

/** addBaseLayer に渡す最小限の Leaflet 代役。追加されたレイヤーを記録する。 */
function addedLayers(mapTiles) {
  const added = [];
  const L = {
    tileLayer(url, options) {
      return { addTo() { added.push({ url, options }); } };
    },
  };
  mapTiles.addBaseLayer(L, {});
  return added;
}

test("透かし入りになった CARTO ではなく OpenStreetMap から配信する", () => {
  const [layer] = addedLayers(loadMapTiles());
  assert.equal(layer.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.doesNotMatch(source, /cartocdn/);
  assert.match(layer.options.attribution, /OpenStreetMap/);
});

test("下地は1枚だけで、同じズームを二重に取得しない", () => {
  assert.equal(addedLayers(loadMapTiles()).length, 1);
});

test("高DPI端末では detectRetina で1段深いタイルを取り、拡大してもぼやけない", () => {
  const [layer] = addedLayers(loadMapTiles());
  assert.equal(layer.options.detectRetina, true);
  // OSM 標準タイルの配信上限。これを超えると引き伸ばしになる。
  assert.equal(layer.options.maxZoom, 19);
});

test("通信量節約と低速回線では等倍タイルに留める", () => {
  const { shouldUseRetinaTiles } = loadMapTiles();
  for (const connection of [{ saveData: true }, { effectiveType: "2g" }, { effectiveType: "slow-2g" }]) {
    assert.equal(shouldUseRetinaTiles(connection), false, JSON.stringify(connection));
  }
  assert.equal(shouldUseRetinaTiles({ effectiveType: "4g" }), true);
  assert.equal(shouldUseRetinaTiles(), true);
  assert.equal(addedLayers(loadMapTiles({ saveData: true }))[0].options.detectRetina, false);
});

test("地図の下地に WebGL / ベクタータイルを読み込まない", () => {
  // コメントには「なぜ使わないか」を残すので、コードだけを見る。
  const code = source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /maplibre/i);
  assert.doesNotMatch(code, /webgl/i);
  // CSSや地図エンジンの副作用インポートを増やさない。
  assert.doesNotMatch(code, /import\s+["']/);
});
