import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function loadMaps() {
  const source = fs.readFileSync(new URL("src/shared/maps.ts", root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports, URLSearchParams });
  return module.exports;
}

test("Google My Maps KML exports itinerary pins and move lines", () => {
  const { buildGoogleMyMapsKml } = loadMaps();
  const kml = buildGoogleMyMapsKml({
    trip: { title: "香港・マカオ <金門>", dates: "", members: "", note: "" },
    links: [],
    settlement: {},
    checklist: [],
    localInfo: [],
    itinerary: [
      {
        date: "2026-10-13",
        day: "Day 5",
        area: "深圳",
        time: "10:00",
        type: "sight",
        typeLabel: "観光",
        title: "蓮花山公園",
        place: "蓮花山公園",
        lat: 22.553,
        lng: 114.055,
      },
      {
        date: "2026-10-13",
        day: "Day 5",
        area: "深圳",
        time: "16:30",
        type: "move",
        typeLabel: "移動",
        origin: "深圳北駅",
        destination: "広州南駅",
        transport: "高鉄",
        duration: "40分",
        originLat: 22.609,
        originLng: 114.029,
        destinationLat: 22.990,
        destinationLng: 113.269,
      },
    ],
  });

  assert.match(kml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(kml, /香港・マカオ &lt;金門&gt;/);
  assert.match(kml, /<Point><coordinates>114\.055,22\.553,0<\/coordinates><\/Point>/);
  assert.match(kml, /<LineString>/);
  assert.match(kml, /114\.029,22\.609,0 113\.269,22\.99,0/);
  assert.match(kml, /移動手段: 高鉄/);
});

test("Google My Maps filename removes unsafe filesystem characters", () => {
  const { googleMyMapsKmlFilename } = loadMaps();
  assert.equal(googleMyMapsKmlFilename("香港 / マカオ:金門?"), "香港__マカオ金門-google-mymaps.kml");
});
