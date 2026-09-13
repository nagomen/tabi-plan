import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { pool } = await import("../dist/db.js");
const { createPlan } = await import("../dist/plan-repo.js");

function result(affectedRows = 1) {
  return [{ affectedRows }];
}

function fakeConnection(statements) {
  return {
    beginTransaction: async () => { statements.push("BEGIN"); },
    commit: async () => { statements.push("COMMIT"); },
    rollback: async () => { statements.push("ROLLBACK"); },
    release: () => {},
    query: async (sql, params = []) => {
      const statement = String(sql);
      statements.push(statement);
      if (statement.includes("SELECT id FROM users")) return [params.map((id) => ({ id }))];
      if (statement.includes("SELECT version, source, visibility")) {
        return [[{ version: 1, source: "local", visibility: "public", status: "draft", open_editing: 0 }]];
      }
      if (statement.includes("SELECT role FROM plan_access_grants")) return [[{ role: "owner" }]];
      if (statement.includes("SELECT user_id FROM plan_members") && statement.includes("user_id IN")) {
        return [[{ user_id: "usr_friend" }]];
      }
      return result();
    },
  };
}

test("new plan metadata, members, and content commit in one transaction", async (t) => {
  const originalGetConnection = pool.getConnection;
  const statements = [];
  let connections = 0;
  pool.getConnection = async () => {
    connections += 1;
    return fakeConnection(statements);
  };
  t.after(() => { pool.getConnection = originalGetConnection; });

  await createPlan({
    id: "pln_atomic", slug: "atomic-trip", title: "秋旅行", owner_user_id: "usr_owner",
    members: [
      { user_id: "usr_owner", role: "owner" },
      { user_id: "usr_friend", role: "editor" },
    ],
    content: {
      itinerary: [{ kind: "sight", title: "美術館", member_ids: ["usr_friend"] }],
      cities: [{ name: "東京" }],
    },
  });

  assert.equal(connections, 1);
  assert.equal(statements.filter((statement) => statement === "BEGIN").length, 1);
  assert.equal(statements.filter((statement) => statement === "COMMIT").length, 1);
  assert.equal(statements.filter((statement) => statement === "ROLLBACK").length, 0);
  assert.ok(statements.some((statement) => statement.includes("INSERT INTO plan_members")));
  assert.ok(statements.some((statement) => statement.includes("INSERT INTO itinerary_items")));
  assert.ok(statements.some((statement) => statement.includes("INSERT INTO plan_cities")));
});

test("invalid initial content rolls the entire new plan back", async (t) => {
  const originalGetConnection = pool.getConnection;
  const statements = [];
  pool.getConnection = async () => fakeConnection(statements);
  t.after(() => { pool.getConnection = originalGetConnection; });

  await assert.rejects(() => createPlan({
    id: "pln_invalid", slug: "invalid-trip", title: "壊れた旅行", owner_user_id: "usr_owner",
    members: [{ user_id: "usr_owner", role: "owner" }],
    content: { itinerary: [{ kind: "not-a-kind" }] },
  }), /行程1件目の種別/);

  assert.equal(statements.filter((statement) => statement === "COMMIT").length, 0);
  assert.equal(statements.filter((statement) => statement === "ROLLBACK").length, 1);
});
