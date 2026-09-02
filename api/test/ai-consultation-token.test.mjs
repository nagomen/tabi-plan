import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { createConsultationToken, selectedCandidatesFromToken } =
  await import("../dist/ai-consultation-token.js");

const context = {
  area: "東京、京都",
  startDate: "2026-08-01",
  endDate: "2026-08-03",
  note: "文化中心",
  cities: [
    { name: "東京", from_date: "2026-08-01", to_date: "2026-08-01" },
    { name: "京都", from_date: "2026-08-02", to_date: "2026-08-03" },
  ],
};
const candidates = [
  { id: "t1", name: "浅草寺", area: "東京", category: "文化", reason: "", duration_minutes: 90 },
  { id: "k1", name: "清水寺", area: "京都", category: "文化", reason: "", duration_minutes: 90 },
];

test("署名済み候補から都市ごとの選択だけを復元する", () => {
  const token = createConsultationToken("user-1", context, candidates);
  const selected = selectedCandidatesFromToken({
    token, userId: "user-1", context, selectedIds: ["t1", "k1"],
  });
  assert.deepEqual(selected.map((item) => item.name), ["浅草寺", "清水寺"]);
});

test("候補表示後に都市・日程が変わった相談を拒否する", () => {
  const token = createConsultationToken("user-1", context, candidates);
  assert.throws(() => selectedCandidatesFromToken({
    token,
    userId: "user-1",
    context: { ...context, endDate: "2026-08-04" },
    selectedIds: ["t1", "k1"],
  }), /都市または日程が変わりました/);
});

test("一部都市を選んでいない相談を拒否する", () => {
  const token = createConsultationToken("user-1", context, candidates);
  assert.throws(() => selectedCandidatesFromToken({
    token, userId: "user-1", context, selectedIds: ["t1"],
  }), /京都/);
});
