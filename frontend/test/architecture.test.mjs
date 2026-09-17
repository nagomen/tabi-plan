import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const frontendRoot = new URL("../", import.meta.url);
const repoRoot = new URL("../../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, frontendRoot), "utf8");

function loadCountry() {
  const javascript = ts.transpileModule(read("src/shared/country.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports });
  return module.exports;
}

test("主要な旅行先を共通の国レジストリで判定する", () => {
  const { countryOf, countryCodeOf } = loadCountry();
  const fixtures = [
    [37.5665, 126.978, "KR"], [22.3193, 114.1694, "HK"], [1.3521, 103.8198, "SG"],
    [52.52, 13.405, "DE"], [-33.8688, 151.2093, "AU"], [21.3069, -157.8583, "US"],
    [43.6532, -79.3832, "CA"], [28.6139, 77.209, "IN"],
  ];
  for (const [lat, lng, code] of fixtures) {
    assert.equal(countryCodeOf(lat, lng), code);
    assert.equal(countryOf(lat, lng).code, code);
  }
});

test("計画エディタはLeaflet地図を軽量ファサード越しに遅延読込する", () => {
  const files = ["main.ts", "place-geocode.ts", "date-range.ts", "cities.ts", "candidates.ts", "days-render.ts", "ai-consultation.ts", "days-actions.ts"];
  for (const file of files) assert.doesNotMatch(read(`src/plan-editor/${file}`), /from ["']\.\/map["']/);
  assert.match(read("src/plan-editor/map-controller.ts"), /import\("\.\/map"\)/);
  assert.doesNotMatch(read("src/plan-editor/map-controller.ts"), /import L from "leaflet"/);
});

test("カジノ店舗の数値・住所・リンクは単一データソースから描画する", () => {
  const html = read("casino-guide.html");
  const source = read("src/casino-guide/venues.ts");
  const renderer = read("src/casino-guide/venue-render.ts");
  assert.match(html, /data-venue-comparison/);
  assert.match(html, /data-venue-grid/);
  assert.doesNotMatch(html, /テーブル180台/);
  assert.match(source, /id: "paradise-city"/);
  assert.match(source, /verifiedAt: "\d{4}-\d{2}-\d{2}"/);
  assert.doesNotMatch(source, /今回の2軒目|今回の龍山→江南ルート|深夜のメイン/);
  assert.match(renderer, /comparisonCells\(venues, field\)/);
});

test("マカオカジノページは共通UIを再利用し、店舗データを一箇所で管理する", () => {
  const html = read("macau-casino-guide.html");
  const main = read("src/macau-casino-guide/main.ts");
  const sharedApp = read("src/casino-guide/app.ts");
  const venues = read("src/macau-casino-guide/venues.ts");
  assert.match(html, /data-venue-comparison/);
  assert.match(html, /data-budget-total/);
  assert.match(main, /initializeCasinoGuidePage/);
  assert.doesNotMatch(main, /loadVenueMap|bindVenueSelection|initializeSectionNavigation/);
  assert.match(sharedApp, /renderVenueGuide\(venues\)/);
  assert.match(sharedApp, /initializeSectionNavigation/);
  assert.match(sharedApp, /import\("\.\/venue-map"\)/);
  assert.match(venues, /id: "venetian"/);
  assert.match(venues, /id: "galaxy"/);
  assert.match(venues, /verifiedAt: "\d{4}-\d{2}-\d{2}"/);
});

test("カジノ予定は旅行データの特集ページへ行程内から遷移できる", () => {
  const itinerary = read("src/dashboard/itinerary-feed.ts");
  const style = read("src/dashboard/style.css");
  assert.match(itinerary, /link\.key === "casinoGuide"/);
  assert.match(itinerary, /data-casino-guide-link/);
  assert.match(itinerary, /String\(item\.type\) !== "sight"/);
  assert.match(style, /\.tl-related-guide\s*\{[^}]*min-height:\s*44px/s);
});

test("デプロイ設定生成は実在するTripConfig項目だけを必須にする", () => {
  const source = fs.readFileSync(new URL("tools/build-trip-config.js", repoRoot), "utf8");
  assert.match(source, /\["tripSlug", "tripTitle", "mode"\]/);
  assert.doesNotMatch(source, /requiredFields = \[[^\]]*"schema"/);
});
