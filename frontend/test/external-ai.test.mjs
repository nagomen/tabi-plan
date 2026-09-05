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

const {
  EXTERNAL_AI_JSON_FORMAT,
  buildExternalAiRefinePrompt,
  parseExternalAiCreateJson,
  parseExternalAiRefineJson,
} = load("src/shared/external-ai.ts");

const sample = {
  format: "tabi-plan-external-ai-v1",
  message: "香港からマカオへ移動する計画にしました。",
  trip: { title: "香港・マカオ旅行", start_date: "2026-10-09", end_date: "2026-10-10" },
  cities: [
    { name: "香港", from_date: "2026-10-09", to_date: "2026-10-09", latitude: 22.3193, longitude: 114.1694 },
    { name: "マカオ", from_date: "2026-10-10", to_date: "2026-10-10", latitude: 22.1987, longitude: 113.5439 },
  ],
  days: [
    {
      date: "2026-10-09",
      area: "香港",
      items: [
        {
          time: "13:00",
          kind: "sight",
          city: "香港",
          title: "中環を散策",
          place: "中環",
          address: "Central, Hong Kong",
          latitude: 22.2819,
          longitude: 114.158,
          note: "",
          from_city: "",
          from_place: "",
          from_address: "",
          from_latitude: null,
          from_longitude: null,
          to_city: "",
          to_place: "",
          to_address: "",
          to_latitude: null,
          to_longitude: null,
          transport: "",
          duration_minutes: 0,
          members: [],
        },
      ],
    },
    {
      date: "2026-10-10",
      area: "マカオ",
      items: [
        {
          time: "21:30",
          kind: "move",
          city: "マカオ",
          title: "香港 → マカオ",
          place: "マカオ外港フェリーターミナル",
          address: "Macau Outer Harbour Ferry Terminal",
          latitude: 22.1968,
          longitude: 113.5586,
          note: "フェリー時刻は要確認",
          from_city: "香港",
          from_place: "香港・マカオ・フェリーターミナル",
          from_address: "Hong Kong Macau Ferry Terminal",
          from_latitude: 22.287,
          from_longitude: 114.152,
          to_city: "マカオ",
          to_place: "マカオ外港フェリーターミナル",
          to_address: "Macau Outer Harbour Ferry Terminal",
          to_latitude: 22.1968,
          to_longitude: 113.5586,
          transport: "フェリー",
          duration_minutes: 60,
          members: ["usr_a"],
        },
      ],
    },
  ],
};

test("external AI prompt asks for the strict Tabi Plan JSON format", () => {
  const prompt = buildExternalAiRefinePrompt({
    title: "香港・マカオ旅行",
    startDate: "2026-10-09",
    endDate: "2026-10-10",
    instruction: "10日の夜にマカオへ移動",
    cities: sample.cities,
    members: [{ user_id: "usr_a", name: "A", from_date: null, to_date: null }],
    currentItinerary: [],
  });
  assert.match(prompt, new RegExp(EXTERNAL_AI_JSON_FORMAT));
  assert.match(prompt, /daysは旅行期間の全日付を1回ずつ返す/);
  assert.match(prompt, /Tabi Planへ貼り付け/);
  assert.match(prompt, /移動だけを先頭や末尾へまとめない/);
});

test("external AI create JSON can be converted to the app draft shape", () => {
  const imported = parseExternalAiCreateJson(JSON.stringify(sample));
  assert.equal(imported.title, "香港・マカオ旅行");
  assert.equal(imported.startDate, "2026-10-09");
  assert.equal(imported.endDate, "2026-10-10");
  assert.equal(imported.draft.days.length, 2);
  assert.equal(imported.draft.days[1].items[0].transport, "フェリー");
  assert.equal(imported.draft.days[1].items[0].duration_minutes, 60);
});

test("external AI refine JSON requires every trip date", () => {
  assert.throws(
    () => parseExternalAiRefineJson(JSON.stringify({ ...sample, days: sample.days.slice(0, 1) }), ["2026-10-09", "2026-10-10"]),
    /不足: 2026-10-10/,
  );
});

test("external AI refine JSON becomes an applyable proposal", () => {
  const proposal = parseExternalAiRefineJson(`\n\`\`\`json\n${JSON.stringify(sample)}\n\`\`\`\n`, ["2026-10-09", "2026-10-10"]);
  assert.equal(proposal.message, sample.message);
  assert.equal(proposal.itinerary.length, 2);
  assert.equal(proposal.itinerary[1].from_city, "香港");
  assert.deepEqual(Array.from(proposal.itinerary[1].members), ["usr_a"]);
});
