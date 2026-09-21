import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough";
process.env.DB_USER = "test";
process.env.DB_PASSWORD = "test";

const { pool } = await import("../dist/db.js");
const { finalizeCandidateSlot, voteForCandidateSlot } = await import("../dist/candidate-vote-repo.js");

const result = (affectedRows = 1) => [{ affectedRows }];

test("全参加者の票が揃っても候補を維持し、ownerの終了操作で行程へ確定する", async (t) => {
  const originalGetConnection = pool.getConnection;
  const statements = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params = []) => {
      const text = String(sql);
      statements.push({ sql: text, params });
      if (text.includes("SELECT owner_user_id FROM plans")) return [[{ owner_user_id: "usr_owner" }]];
      if (text.includes("FROM plan_candidates") && text.includes("adopted_at")) return [[
        {
          id: "cnd_a", title: "市場で昼食", place: "中央市場", slot_id: "slot_lunch",
          item_date: "2026-10-10", start_time: "12:00:00", kind: "food", duration_minutes: 60,
          lat: 37.1, lng: 127.1, note: "混雑時は次案", member_ids: null, adopted_at: null,
        },
        {
          id: "cnd_b", title: "カフェ", place: "駅前", slot_id: "slot_lunch",
          item_date: "2026-10-10", start_time: "12:00:00", kind: "food", duration_minutes: 45,
          lat: null, lng: null, note: null, member_ids: null, adopted_at: null,
        },
      ]];
      if (text.includes("SELECT pm.user_id")) return [[{ user_id: "usr_owner" }, { user_id: "usr_friend" }]];
      if (text.includes("SELECT v.candidate_id, v.user_id")) return [[
        { candidate_id: "cnd_a", user_id: "usr_owner" },
        { candidate_id: "cnd_a", user_id: "usr_friend" },
      ]];
      if (text.includes("next_order")) return [[{ next_order: 4 }]];
      return result();
    },
  };
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  const voted = await voteForCandidateSlot("pln_1", "slot_lunch", "cnd_a", "usr_owner");
  assert.deepEqual(voted, {
    resolved: false, readyToFinalize: true, tied: false,
    winnerCandidateId: "cnd_a", votedCount: 2, eligibleCount: 2,
  });
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO itinerary_items")), false);

  const finalized = await finalizeCandidateSlot("pln_1", "slot_lunch", "usr_owner");
  assert.equal(finalized.resolved, true);
  assert.equal(finalized.readyToFinalize, false);
  const insert = statements.find(({ sql }) => sql.includes("INSERT INTO itinerary_items"));
  assert.ok(insert);
  assert.equal(insert.params[6], "市場で昼食");
  assert.equal(insert.params[10], 37.1);
  assert.equal(insert.params[11], 127.1);
  assert.ok(statements.some(({ sql }) => sql.includes("UPDATE plan_candidates SET adopted_at")));
});

test("全員投票済みでも同票なら候補枠を維持する", async (t) => {
  const originalGetConnection = pool.getConnection;
  const statements = [];
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql, params = []) => {
      const text = String(sql);
      statements.push({ sql: text, params });
      if (text.includes("SELECT owner_user_id FROM plans")) return [[{ owner_user_id: "usr_owner" }]];
      if (text.includes("FROM plan_candidates") && text.includes("adopted_at")) return [[
        { id: "cnd_a", title: "A", slot_id: "slot_1", item_date: "2026-10-10", member_ids: null, adopted_at: null },
        { id: "cnd_b", title: "B", slot_id: "slot_1", item_date: "2026-10-10", member_ids: null, adopted_at: null },
      ]];
      if (text.includes("SELECT pm.user_id")) return [[{ user_id: "usr_owner" }, { user_id: "usr_friend" }]];
      if (text.includes("SELECT v.candidate_id, v.user_id")) return [[
        { candidate_id: "cnd_a", user_id: "usr_owner" },
        { candidate_id: "cnd_b", user_id: "usr_friend" },
      ]];
      return result();
    },
  };
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  const voted = await voteForCandidateSlot("pln_1", "slot_1", "cnd_a", "usr_owner");
  assert.equal(voted.resolved, false);
  assert.equal(voted.readyToFinalize, false);
  assert.equal(voted.tied, true);
  assert.equal(statements.some(({ sql }) => sql.includes("INSERT INTO itinerary_items")), false);
});

test("owner以外は全員投票後でも投票を終了できない", async (t) => {
  const originalGetConnection = pool.getConnection;
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {},
    query: async (sql) => {
      const text = String(sql);
      if (text.includes("SELECT owner_user_id FROM plans")) return [[{ owner_user_id: "usr_owner" }]];
      if (text.includes("FROM plan_candidates") && text.includes("adopted_at")) return [[
        { id: "cnd_a", title: "A", slot_id: "slot_1", item_date: "2026-10-10", member_ids: null, adopted_at: null },
        { id: "cnd_b", title: "B", slot_id: "slot_1", item_date: "2026-10-10", member_ids: null, adopted_at: null },
      ]];
      if (text.includes("SELECT pm.user_id")) return [[{ user_id: "usr_owner" }, { user_id: "usr_friend" }]];
      return result();
    },
  };
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  await assert.rejects(
    finalizeCandidateSlot("pln_1", "slot_1", "usr_friend"),
    /旅行マスターだけ/,
  );
});
