import test from "node:test";
import assert from "node:assert/strict";

process.env.API_TOKEN = "test-public-token";
process.env.SESSION_SECRET = "test-session-secret-which-is-long-enough";
process.env.DB_USER = "test";
process.env.DB_PASSWORD = "test";

const { pool } = await import("../dist/db.js");
const { createPlaceholderMember } = await import("../dist/plan-member-repo.js");
const { acceptInvite, inspectInvite } = await import("../dist/plan-invite-repo.js");

function result(affectedRows = 1) {
  return [{ affectedRows }];
}

test("同名でも旅行専用の仮メンバーを別IDで作成する", async (t) => {
  const originalGetConnection = pool.getConnection;
  const statements = [];
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql, params) => {
      statements.push({ sql, params });
      return result();
    },
  };
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  const first = await createPlaceholderMember("pln_1", "たかし", "usr_owner");
  const second = await createPlaceholderMember("pln_1", "たかし", "usr_owner");
  assert.notEqual(first.user.id, second.user.id);
  assert.match(first.user.id, /^gst_/);
  assert.equal(first.user.display_name, "たかし");
  assert.equal(statements.filter(({ sql }) => sql.includes("INSERT INTO plan_member_placeholders")).length, 2);
});

test("ログイン前の招待確認で未登録メンバー候補を返す", async (t) => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (sql.includes("FROM plan_invites i")) {
      return [[{
        id: "inv_1", plan_id: "pln_1", status: "pending", invited_name: "たかし",
        invited_user_id: "gst_1", expires_at: "2099-01-01 00:00:00", slug: "summer", title: "夏旅行",
      }]];
    }
    if (sql.includes("FROM plan_member_placeholders WHERE")) return [[{ user_id: "gst_1" }]];
    if (sql.includes("FROM plan_member_placeholders pmp")) {
      return [[
        { user_id: "gst_1", display_name: "たかし" },
        { user_id: "gst_2", display_name: "たかし" },
      ]];
    }
    return [[]];
  };
  t.after(() => { pool.query = originalQuery; });

  const inspected = await inspectInvite("secret-token");
  assert.equal(inspected.planTitle, "夏旅行");
  assert.equal(inspected.requiresMemberSelection, true);
  assert.deepEqual(inspected.memberOptions, [
    { userId: "gst_1", displayName: "たかし" },
    { userId: "gst_2", displayName: "たかし" },
  ]);
});

test("招待承諾は仮メンバーの旅行内データをアカウントへ一括移行する", async (t) => {
  const originalGetConnection = pool.getConnection;
  const statements = [];
  const connection = {
    beginTransaction: async () => { statements.push({ sql: "BEGIN", params: [] }); },
    commit: async () => { statements.push({ sql: "COMMIT", params: [] }); },
    rollback: async () => { statements.push({ sql: "ROLLBACK", params: [] }); },
    release: () => {},
    query: async (sql, params = []) => {
      statements.push({ sql, params });
      if (sql.includes("FROM plan_invites i")) {
        return [[{
          id: "inv_1", plan_id: "pln_1", role: "editor", status: "pending",
          created_by_id: "usr_owner", invited_user_id: "gst_1", accepted_by_id: null,
          expires_at: "2099-01-01 00:00:00", slug: "summer",
        }]];
      }
      if (sql.includes("FROM plan_member_placeholders WHERE")) return [[{ user_id: "gst_1" }]];
      if (sql.includes("JOIN plan_members pm")) return [[{ user_id: "gst_1", role: "editor" }]];
      if (sql.includes("SELECT user_id FROM plan_members")) return [[]];
      return result();
    },
  };
  pool.getConnection = async () => connection;
  t.after(() => { pool.getConnection = originalGetConnection; });

  const accepted = await acceptInvite("secret-token", "usr_takashi", "gst_1");
  assert.deepEqual(accepted, { planSlug: "summer" });
  const sql = statements.map((entry) => entry.sql).join("\n");
  assert.match(sql, /UPDATE expenses SET payer_user_id/);
  assert.match(sql, /INSERT INTO expense_shares/);
  assert.match(sql, /UPDATE settlements SET from_user_id/);
  assert.match(sql, /UPDATE settlements SET to_user_id/);
  assert.match(sql, /UPDATE plan_candidates SET proposed_by_id/);
  assert.match(sql, /INSERT IGNORE INTO plan_candidate_votes/);
  assert.match(sql, /SET status = 'claimed'/);
  assert.match(sql, /COMMIT/);
  assert.doesNotMatch(sql, /INSERT INTO friendships/);
});
