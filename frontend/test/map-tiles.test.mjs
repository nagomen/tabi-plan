import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const source = fs.readFileSync(new URL("src/shared/map-tiles.ts", root), "utf8");

test("map base layer prioritizes OpenFreeMap vector rendering", () => {
  assert.match(source, /https:\/\/tiles\.openfreemap\.org\/styles\/liberty/);
  assert.match(source, /import "maplibre-gl\/dist\/maplibre-gl\.css"/);
  assert.match(source, /await import\("@maplibre\/maplibre-gl-leaflet"\)/);
  assert.match(source, /maplibreGL\(\{ style: VECTOR_STYLE \}\)/);
  assert.match(source, /addAttribution\(VECTOR_ATTRIBUTION\)/);
});

test("map no longer switches raster resolution by zoom", () => {
  assert.doesNotMatch(source, /HIGH_RESOLUTION_TILE_MIN_ZOOM/);
  assert.doesNotMatch(source, /@2x\.png/);
  assert.doesNotMatch(source, /tileDensityAtZoom/);
});

test("map keeps a normal raster fallback for WebGL failures", () => {
  assert.match(source, /function supportsWebGL\(\)/);
  assert.match(source, /addFallbackRasterLayer\(L, map\)/);
  assert.match(source, /basemaps\.cartocdn\.com\/rastertiles\/voyager/);
});

test("vector labels prefer Japanese names", () => {
  assert.match(source, /\["get", "name:ja"\]/);
  assert.match(source, /\["get", "name"\]/);
  assert.match(source, /\["get", "name:latin"\]/);
});
