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

test("別行動は常設タブを保ち、タイムラインをGit graph型のbranchとmergeで表示する", () => {
  const itinerary = read("src/dashboard/itinerary-feed.ts");
  const style = read("src/dashboard/style.css");
  assert.match(itinerary, /class="tl-day-tabs" role="tablist"/);
  assert.match(itinerary, /class="tl-day-tab" type="button" role="tab"/);
  assert.match(itinerary, /class="tl-merge"/);
  assert.match(itinerary, /class="tl-merge-node">合流/);
  assert.match(itinerary, />合流<\/span>/);
  assert.match(itinerary, /class="tl-merge-branch"[^>]*data-track-day=/);
  assert.match(itinerary, /aria-label="\$\{escapeHtml\(label\)\}の別行動を表示"/);
  assert.doesNotMatch(itinerary, /ここで合流|この先は全員共通|tl-branch-switch/);
  assert.doesNotMatch(itinerary, /tl-merge-label|tl-merge-out/);
  assert.match(style, /\.tl-item\.is-branch-specific \.tl-dot/);
  assert.match(style, /\.tl-day-tab\[aria-selected="true"\]/);
});

test("費用フォームは人をuser_idで指し、外貨はレート入力を必須にする", () => {
  const entry = read("src/dashboard/expense-entry.ts");
  const form = read("src/shared/expense-form.ts");
  // 表示名で金額を割り当てると、同名メンバーがいたときに別人へ付け替わる。
  assert.match(entry, /name="targets" value="\$\{escapeHtml\(member\.id\)\}"/);
  assert.match(entry, /data-share-id="\$\{escapeHtml\(member\.id\)\}"/);
  // 保存時に表示名からIDを引き直さない（解決は選択肢を組み立てる1か所だけ）。
  assert.doesNotMatch(entry, /data-share-name|const idOf =/);
  assert.match(entry, /payerUserId: \(field\("payer"\) as HTMLSelectElement\)\.value/);
  assert.match(form, /data-share-id/);
  // レート未入力のまま外貨を保存すると、基準通貨の額として記録されてしまう。
  assert.match(entry, /data-fx-field/);
  assert.match(entry, /fxRateFromUnitRate\(unitRate, currency, baseCurrency\)/);
  assert.match(entry, /if \(!fxRate\)/);
  assert.match(entry, /amountMinor: toMinor\(amount, currency\)/);
  // 全員等分の母集団が空になる日（旅行期間外の前払い）でも保存できる。
  assert.match(entry, /presentIds\.length \? presentIds : TripPlans\.memberIdsPresentOn\(planId\(\), ""\)/);
});

test("スマホで入力しても画面が拡大・再描画されない", () => {
  const style = read("src/dashboard/style.css");
  const entry = read("src/dashboard/expense-entry.ts");
  // iOS Safari は16px未満の入力欄で自動ズームする。指で触る幅では下回らせない。
  assert.match(style, /\.tl-field textarea \{[^}]*font-size: 16px/s);
  assert.match(style, /@media \(min-width: 721px\) \{\s*\.tl-field input[\s\S]*?font-size: 14px/);
  // キーボードが出ても送信ボタンが隠れないよう、実表示領域に追従させる。
  assert.match(style, /\.tl-sheet-panel \{[^}]*max-height: 88dvh/s);
  // 合計行の行数が変わると下の内容ごと動くので、高さを先に確保する。
  assert.match(style, /\.tl-share-total \{[^}]*min-height/s);
  // 入力中の作り直しはフォーカスとキーボードを失わせる。
  assert.match(entry, /existingForm\.contains\(document\.activeElement\)/);
  // 開いた直後の自動フォーカスは、タッチ端末では画面が飛ぶだけ。
  assert.match(entry, /\(hover: hover\) and \(pointer: fine\)/);
});

test("閲覧のみのモードでは精算完了を描画も実行もしない", () => {
  const settlement = read("src/dashboard/settlement.ts");
  assert.match(settlement, /isReadOnly\(\) \? "" : `<button[^`]*data-settlement-complete/);
  assert.match(settlement, /data-settlement-complete[\s\S]*?addEventListener\("click"[\s\S]*?if \(isReadOnly\(\)\) return;/);
});

test("デプロイ設定生成は実在するTripConfig項目だけを必須にする", () => {
  const source = fs.readFileSync(new URL("tools/build-trip-config.js", repoRoot), "utf8");
  assert.match(source, /\["tripSlug", "tripTitle", "mode"\]/);
  assert.doesNotMatch(source, /requiredFields = \[[^\]]*"schema"/);
});

test("マイページのAIキー設定は生キーをキャッシュせず専用APIだけを使う", () => {
  const html = read("mypage.html");
  const ui = read("src/mypage/ai-key.ts");
  const db = read("src/shared/db.ts");
  assert.match(html, /data-ai-key-form/);
  assert.match(html, /autocomplete="new-password"/);
  assert.match(ui, /saveAiCredential\(apiKey\)/);
  assert.match(ui, /input\.value = ""/);
  assert.match(db, /\/api\/account\/ai-credential/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
});
