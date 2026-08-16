import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadGeocoding(fetchImpl) {
  const source = fs.readFileSync(new URL("src/shared/geocoding.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    fetch: fetchImpl,
    URLSearchParams,
    Date,
    console,
    window: { setTimeout },
  };
  vm.runInNewContext(javascript, context);
  return module.exports;
}

test("public Nominatim is never called for automatic suggestions", async () => {
  let calls = 0;
  const geo = loadGeocoding(async () => { calls += 1; throw new Error("unexpected fetch"); });
  const results = await geo.searchLocations("中尊寺", {}, { automatic: true });
  assert.deepEqual(JSON.parse(JSON.stringify(results)), []);
  assert.equal(calls, 0);
});

test("explicit Nominatim search sends country and bounded city context and is cached", async () => {
  const urls = [];
  const geo = loadGeocoding(async (url) => {
    urls.push(String(url));
    return {
      ok: true,
      json: async () => [{
        place_id: 1, osm_type: "N", osm_id: 2, display_name: "中尊寺, 平泉町, 日本",
        lat: "39.0015", lon: "141.0990", addresstype: "tourism", address: { country_code: "jp" },
      }],
    };
  });
  const context = { cityName: "平泉", lat: 38.987, lng: 141.1122, countryCode: "JP", requireNearby: true };
  const first = await geo.searchLocations("中尊寺", context);
  const second = await geo.searchLocations("中尊寺", context);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(urls.length, 1);
  const url = new URL(urls[0]);
  assert.equal(url.searchParams.get("countrycodes"), "jp");
  assert.equal(url.searchParams.get("bounded"), "1");
  assert.ok(url.searchParams.get("viewbox"));
  assert.match(url.searchParams.get("q") || "", /中尊寺.*平泉/);
});

test("Mapbox search receives country, proximity, bounding box and city type", async () => {
  let requestedUrl = "";
  const geo = loadGeocoding(async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => ({ features: [{
        id: "place.1",
        properties: {
          mapbox_id: "place.1", name: "大館市", place_formatted: "秋田県, 日本",
          feature_type: "place", context: { country: { country_code: "JP" } },
        },
        geometry: { coordinates: [140.5652, 40.2717] },
      }] }),
    };
  });
  const results = await geo.searchLocations("大館市", {
    lat: 40.27, lng: 140.56, countryCode: "JP", purpose: "city", requireNearby: true,
  }, { mapboxToken: "pk.test" });
  assert.equal(results.length, 1);
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("country"), "JP");
  assert.equal(url.searchParams.get("proximity"), "140.56,40.27");
  assert.ok(url.searchParams.get("bbox"));
  assert.equal(url.searchParams.get("types"), "place,locality,district");
});

test("move endpoint search does not mix in the itinerary city or proximity", async () => {
  let requestedUrl = "";
  const geo = loadGeocoding(async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      json: async () => [
        {
          place_id: 10, osm_type: "R", osm_id: 17864987,
          display_name: "東京国際空港, 羽田空港, 東京都, 日本",
          lat: "35.5456924", lon: "139.7760994", addresstype: "aeroway",
          address: { country_code: "jp" },
        },
        {
          place_id: 11, osm_type: "R", osm_id: 12854533,
          display_name: "羽田空港, 大田区, 東京都, 日本",
          lat: "35.5513668", lon: "139.7760343", addresstype: "neighbourhood",
          address: { country_code: "jp" },
        },
      ],
    };
  });
  const results = await geo.searchLocations("羽田空港", {
    cityName: "金門島", lat: 24.43, lng: 118.32, countryCode: "JP", purpose: "move",
  });
  assert.equal(results.length, 2);
  assert.match(results[0].label, /東京国際空港/);
  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("q"), "羽田空港");
  assert.equal(url.searchParams.get("countrycodes"), "jp");
  assert.equal(url.searchParams.has("viewbox"), false);
  assert.equal(url.searchParams.has("bounded"), false);
});

test("airport intent ranks an aerodrome above unrelated provider results", async () => {
  const geo = loadGeocoding(async () => ({
    ok: true,
    json: async () => [
      {
        place_id: 20, osm_type: "N", osm_id: 1, display_name: "動視暴雪, 台北市, 台湾",
        lat: "25.0529", lon: "121.6070", addresstype: "office", address: { country_code: "tw" },
      },
      {
        place_id: 21, osm_type: "R", osm_id: 2, display_name: "台湾桃園国際空港, 桃園市, 台湾",
        lat: "25.0793", lon: "121.2346", addresstype: "aeroway", address: { country_code: "tw" },
      },
    ],
  }));
  const results = await geo.searchLocations("台湾空港", { countryCode: "TW", purpose: "move" });
  assert.equal(results.length, 2);
  assert.match(results[0].label, /台湾桃園国際空港/);
});

test("editor invalidates coordinates when place or city names change", () => {
  const source = fs.readFileSync(new URL("src/plan-editor/main.ts", root), "utf8");
  assert.match(source, /previousValue !== target\.value[\s\S]*clearItemCoords\(found\.item, "place"\)/);
  assert.match(source, /previousName !== city\.name[\s\S]*city\.lat = "";[\s\S]*city\.lng = "";/);
  assert.doesNotMatch(source, /if \(results\[0\]\) \{ city\.lat/);
  assert.match(source, /const autoApplySingle = options\.autoApplySingle === true/);
  assert.match(source, /if \(isMoveEndpoint && endpointCountry\)[\s\S]*purpose: "move"/);
});

test("built-in coordinates do not confuse a city with its station", () => {
  const source = fs.readFileSync(new URL("src/shared/geo.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports });
  const tokyo = module.exports.coordsFor("東京");
  const tokyoStation = module.exports.coordsFor("東京 駅");
  assert.notDeepEqual(JSON.parse(JSON.stringify(tokyo)), JSON.parse(JSON.stringify(tokyoStation)));
  assert.deepEqual(JSON.parse(JSON.stringify(tokyoStation)), { lat: 35.6812, lng: 139.7671 });
});
