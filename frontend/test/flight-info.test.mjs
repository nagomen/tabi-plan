import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function load(relativePath) {
  const source = fs.readFileSync(new URL(relativePath, root), "utf8");
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(javascript, { module, exports: module.exports });
  return module.exports;
}

const { parseFlight } = load("src/shared/flight-info.ts");

test("parses airline, flight number, and dep/arr from a real AI-generated move", () => {
  const flight = parseFlight({
    transport: "Hong Kong Express UO857",
    note: "Hong Kong Express Airways UO857 / 08:00 NRT発、11:55 HKG着 / 所要4時間55分（現地時刻）",
    title: "成田国際空港 → 香港国際空港",
  });
  assert.ok(flight);
  assert.equal(flight.flightNo, "UO857");
  assert.equal(flight.airline, "Hong Kong Express");
  assert.deepEqual({ ...flight.dep }, { code: "NRT", time: "08:00" });
  assert.deepEqual({ ...flight.arr }, { code: "HKG", time: "11:55" });
  // note の便名・発着・所要は表示側で構造化するので、残りメモは空になる。
  assert.equal(flight.restNote, "");
});

test("keeps note fragments that are not duplicated flight info", () => {
  const flight = parseFlight({
    transport: "ANA855",
    note: "9:30 HND発 12:40 TSA着 / 預け荷物は23kgまで",
    title: "羽田空港 → 台北松山空港",
  });
  assert.ok(flight);
  assert.equal(flight.flightNo, "ANA855");
  assert.equal(flight.airline, "");
  assert.deepEqual({ ...flight.dep }, { code: "HND", time: "9:30" });
  assert.deepEqual({ ...flight.arr }, { code: "TSA", time: "12:40" });
  assert.equal(flight.restNote, "預け荷物は23kgまで");
});

test("non-flight moves return null even when airport codes appear in the note", () => {
  // Airport Express（鉄道）。HKG着 という文字列だけでは便扱いしない。
  assert.equal(parseFlight({
    transport: "Airport Express",
    note: "11:55 HKG着後、市内へ移動",
    title: "香港国際空港 → 九龍駅",
  }), null);
  // フェリーも null。
  assert.equal(parseFlight({
    transport: "TurboJET",
    note: "1時間 / 現行ダイヤの始発。要最終確認。",
    title: "マカオ外港フェリーターミナル → 香港・マカオ・フェリーターミナル",
  }), null);
  // 空港行きの地上移動。帰国便名がメモにあっても、移動自体は航空券ではない。
  assert.equal(parseFlight({
    transport: "バス・フェリー等",
    note: "香港エクスプレス UO622 17:35発に合わせて余裕を持って移動",
    title: "コタイ → 香港国際空港",
  }), null);
});

test("aviation context is required so codes in plain text do not trigger", () => {
  // 航空文脈の語が無ければ、大文字＋数字でも便名扱いしない。
  assert.equal(parseFlight({
    transport: "タクシー",
    note: "MTR2番出口 IC500 で集合",
    title: "ホテル → 夜市",
  }), null);
});

test("times are not mistaken for flight numbers", () => {
  const flight = parseFlight({
    transport: "飛行機",
    note: "JL8 / 帰りの便は未定",
    title: "成田空港 → ロンドン",
  });
  assert.ok(flight);
  assert.equal(flight.flightNo, "JL8");
  assert.equal(flight.restNote, "帰りの便は未定");
  // 「IN 05:00」のような時刻表記は便名にしない。
  assert.equal(parseFlight({
    transport: "飛行機",
    note: "IN 05:00",
    title: "空港へ",
  }), null);
});
