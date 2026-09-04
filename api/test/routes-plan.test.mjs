import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { pool } = await import("../dist/db.js");
const { route } = await import("../dist/routes.js");

test("sourceは作成後にsampleへ変更できない", async () => {
  const result = await route("PATCH", "/api/plans/pln_1", {
    source: "sample",
    expected_version: 1,
  }, "usr_owner");
  assert.equal(result.status, 400);
  assert.match(result.body.error, /更新できない項目.*source/);
});

test("公開共同編集者は旅行名・期間などのメタデータを変更できない", async (t) => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    if (String(sql).includes("FROM plans p") && String(sql).includes("LEFT JOIN plan_members")) {
      return [[{
        source: "local",
        visibility: "public",
        status: "published",
        open_editing: 1,
        owner_user_id: "usr_owner",
        role: null,
      }], []];
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  t.after(() => { pool.query = originalQuery; });

  const result = await route("PATCH", "/api/plans/pln_1", {
    title: "勝手に変えた名前",
    expected_version: 1,
  }, "usr_collaborator");
  assert.deepEqual(result, { status: 403, body: { error: "forbidden" } });
});
